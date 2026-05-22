import type { Buffer } from 'node:buffer'

import type {
  AudioPlayer,
  AudioReceiveStream,
  VoiceConnection,
} from '@discordjs/voice'
import type {
  DiscordVoiceState,
  DiscordVoiceSttConfig,
  DiscordVoiceTranscript,
} from '@proj-airi/stage-shared'
import type { Client as DiscordClient, VoiceBasedChannel } from 'discord.js'

import {
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  EndBehaviorType,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
} from '@discordjs/voice'
import { useLogg } from '@guiiai/logg'
// NOTICE: `prism-media` ships as a CJS module but exposes a clean ESM-friendly
// shape. Electron's main process here is ESM (`"type": "module"`), so we use a
// named import for the `opus` namespace. We avoid the `OpusDecoder` from
// `services/discord-bot/src/utils/opus.ts` (which uses `opusscript` at 16kHz)
// because Discord ships 48kHz stereo Opus frames and we want native decoding
// accuracy + a single downsample at the end.
import { opus as prismOpus } from 'prism-media'

import { decodeToPcm } from './voice-audio'
import { transcribePcmMono16k } from './voice-stt'
import { createVoiceSttSession } from './voice-stt-session'

const log = useLogg('discord-voice').useGlobalConfig()

/** Discord receivers emit Opus at this rate; we decode → downsample → STT. */
const DECODE_SAMPLE_RATE = 48000
const DECODE_CHANNELS = 2

/**
 * Per-utterance silence tail before we kick STT. Discord's `EndBehaviorType.AfterSilence`
 * itself uses 1000ms; we keep it tight (600ms) so latency stays low for short replies.
 * Lower this further only if you're confident your STT can handle truncated utterances.
 */
const SILENCE_AFTER_MS = 600

/** Floor for how much speech (ms) is worth submitting to STT. Anything shorter is keystroke noise. */
const MIN_UTTERANCE_MS = 250

/**
 * Hard cap on a single utterance buffer so a stuck stream never balloons memory.
 * 30s mono 16kHz s16le ≈ 960 KB.
 */
const MAX_UTTERANCE_MS = 30_000

/**
 * Start STT for completed long chunks while the user is still speaking, then
 * emit a single merged transcript after speech ends.
 */
const STT_PREFLIGHT_CHUNK_MS = 5_000

interface UserStream {
  readonly userId: string
  readonly username: string
  readonly displayName: string
  readonly opusStream: AudioReceiveStream
  /** Decoder pipeline: opus → s16le 48k stereo. We resample/downmix during finalize. */
  readonly decoder: import('prism-media').opus.Decoder
  readonly sttSession: ReturnType<typeof createVoiceSttSession>
  totalBytes: number
  startedAt: number
  finalizing: boolean
  closed: boolean
}

export interface VoiceManagerHandle {
  /** Join the voice channel of the user who triggered the interaction. Returns the resolved channel name. */
  join: (channel: VoiceBasedChannel, sttConfig: DiscordVoiceSttConfig) => Promise<{ ok: true, channelName: string } | { ok: false, error: string }>
  leave: () => Promise<void>
  isConnected: () => boolean
  getState: () => DiscordVoiceState
  /** Push a TTS audio buffer (e.g. mp3 from vieneutts) for playback in the active channel. */
  enqueueTtsAudio: (audio: Buffer, mime: string) => void
  /** Update the STT config (renderer drives this). */
  setSttConfig: (config: DiscordVoiceSttConfig) => void
  destroy: () => Promise<void>
}

export interface VoiceManagerCallbacks {
  onStateChange: (state: DiscordVoiceState) => void
  onTranscript: (transcript: DiscordVoiceTranscript) => void
  /** Notify the host service so it can also push a routed inbound message to the chat pipeline. */
  onLog: (type: string, summary: string) => void
}

export interface CreateVoiceManagerOptions {
  getDiscordClient: () => DiscordClient | null
  callbacks: VoiceManagerCallbacks
}

export function createVoiceManager(options: CreateVoiceManagerOptions): VoiceManagerHandle {
  const { getDiscordClient, callbacks } = options

  let connection: VoiceConnection | null = null
  let audioPlayer: AudioPlayer | null = null
  let activeGuildId: string | null = null
  let activeChannelId: string | null = null
  let activeChannelName: string | null = null
  let lastError: string | null = null
  let speaking = false
  const activeSpeakers = new Set<string>()
  const userStreams = new Map<string, UserStream>()

  // STT config is cached on the manager. The renderer pushes it on join + on settings change.
  let sttConfig: DiscordVoiceSttConfig | null = null

  // Sequential TTS queue. Each entry is a transcoded PCM stream ready for AudioPlayer.
  // Mp3 → ffmpeg → s16le 48k stereo PCM → createAudioResource(StreamType.Raw).
  const ttsQueue: Array<{ buffer: Buffer, mime: string }> = []
  let ttsDraining = false

  function buildState(): DiscordVoiceState {
    return {
      connected: !!connection && connection.state.status === VoiceConnectionStatus.Ready,
      speaking,
      guildId: activeGuildId,
      channelId: activeChannelId,
      channelName: activeChannelName,
      lastError,
      activeSpeakers: Array.from(activeSpeakers),
    }
  }

  function emitState() {
    callbacks.onStateChange(buildState())
  }

  /**
   * Drain any TTS audio in the queue into the active connection.
   *
   * We do not use a streaming approach here because `@discordjs/voice` works best
   * with one resource per utterance — the `AudioPlayer` will re-enter `Idle` between
   * resources and we just trigger the next play. This also means each TTS sentence
   * gets its own file boundary, which is what we want for natural pacing.
   */
  async function drainTtsQueue() {
    if (ttsDraining || !connection || !audioPlayer)
      return
    ttsDraining = true

    // NOTICE: `connection`/`audioPlayer` are module-scope and can be cleared by
    // async state-change handlers during teardown. ESLint's no-unmodified-loop-condition
    // is over-eager here because both variables are mutated outside this scope.
    // eslint-disable-next-line no-unmodified-loop-condition
    while (ttsQueue.length > 0 && audioPlayer && connection) {
      const next = ttsQueue.shift()!
      try {
        const pcmStream = decodeToPcm(next.buffer, { sampleRate: 48000, channels: 2 })
        const resource = createAudioResource(pcmStream, {
          inputType: StreamType.Raw,
          inlineVolume: false,
        })
        audioPlayer.play(resource)
        speaking = true
        emitState()

        // Wait for player to return to idle before queueing the next resource so
        // the audio doesn't overlap. A 60s safety timeout guards against stuck
        // streams (e.g. broken ffmpeg).
        await entersState(audioPlayer, AudioPlayerStatus.Playing, 5_000).catch(() => {})
        await Promise.race([
          new Promise<void>((resolve) => {
            const onIdle = (_old: any, newState: any) => {
              if (newState.status === AudioPlayerStatus.Idle) {
                audioPlayer?.off('stateChange', onIdle)
                resolve()
              }
            }
            audioPlayer!.on('stateChange', onIdle)
          }),
          new Promise<void>((resolve) => {
            setTimeout(resolve, 60_000)
          }),
        ])
      }
      catch (err: any) {
        log.withError(err).error('TTS playback failed')
        callbacks.onLog('VOICE_TTS_ERROR', err?.message ?? 'unknown')
      }
    }

    speaking = false
    emitState()
    ttsDraining = false
  }

  function attachUserStream(userId: string, username: string, displayName: string) {
    if (!connection)
      return
    if (userStreams.has(userId))
      return

    // Guild members.cache ID for the bot itself — never subscribe to ourselves.
    const client = getDiscordClient()
    if (client?.user?.id === userId)
      return

    const opusStream = connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: SILENCE_AFTER_MS },
    })

    const decoder = new prismOpus.Decoder({
      rate: DECODE_SAMPLE_RATE,
      channels: DECODE_CHANNELS,
      frameSize: 960,
    })

    const state: UserStream = {
      userId,
      username,
      displayName,
      opusStream,
      decoder,
      sttSession: createVoiceSttSession({
        preflightChunkMs: STT_PREFLIGHT_CHUNK_MS,
        transcribe: async (pcm) => {
          const config = sttConfig
          if (!config) {
            callbacks.onLog('VOICE_STT_SKIP', 'No STT config available')
            return ''
          }

          return transcribePcmMono16k(pcm, config).catch((err) => {
            log.withError(err).warn('STT failed')
            callbacks.onLog('VOICE_STT_ERROR', err?.message ?? 'unknown')
            return ''
          })
        },
      }),
      totalBytes: 0,
      startedAt: Date.now(),
      finalizing: false,
      closed: false,
    }
    userStreams.set(userId, state)

    opusStream.on('error', (err) => {
      log.withError(err).withField('userId', userId).warn('Voice opus stream error')
    })

    decoder.on('error', (err) => {
      log.withError(err).withField('userId', userId).warn('Voice decoder error')
    })

    decoder.on('data', (chunk: Buffer) => {
      if (state.finalizing || state.closed)
        return

      state.sttSession.appendStereo48k(chunk)
      state.totalBytes += chunk.length

      // Soft cap utterance length — finalize aggressively if user filibusters.
      const elapsed = Date.now() - state.startedAt
      if (elapsed > MAX_UTTERANCE_MS) {
        log.withField('userId', userId).warn('Utterance exceeded max length; force-finalizing')
        finalizeUtterance(userId).catch(() => {})
      }
    })

    // The opus stream's `end` fires after SILENCE_AFTER_MS of silence per
    // `EndBehaviorType.AfterSilence`. That's our cue to finalize the utterance.
    opusStream.on('end', () => {
      finalizeUtterance(userId).catch(() => {})
    })

    opusStream.pipe(decoder as unknown as NodeJS.WritableStream)
  }

  /**
   * Finalize the current voice turn and emit one transcript. Long turns may
   * already have STT chunks in flight via the per-user session.
   */
  async function finalizeUtterance(userId: string) {
    const state = userStreams.get(userId)
    if (!state || state.finalizing)
      return
    state.finalizing = true

    try {
      const elapsed = Date.now() - state.startedAt
      if (state.totalBytes === 0 || elapsed < MIN_UTTERANCE_MS) {
        return
      }

      if (!sttConfig) {
        callbacks.onLog('VOICE_STT_SKIP', 'No STT config available')
        return
      }

      const monoSizeKb = Math.round((state.totalBytes / 6) / 1024)
      callbacks.onLog('VOICE_UTTERANCE', `${state.displayName}: ${Math.round(elapsed / 100) / 10}s, ${monoSizeKb} KB`)

      const sttStartedAt = Date.now()
      const result = await state.sttSession.finalize()
      callbacks.onLog('VOICE_STT_DONE', `${state.displayName}: ${Date.now() - sttStartedAt}ms after end, ${result.chunks} chunk(s), ${result.preflightChunks} preflight`)

      const text = result.text

      if (!text || text.trim().length === 0)
        return

      // Filter classic Whisper junk markers.
      const cleaned = text.trim()
      if (/^\[[A-Z_ ]+\]$/.test(cleaned))
        return

      callbacks.onTranscript({
        guildId: activeGuildId ?? '',
        channelId: activeChannelId ?? '',
        userId: state.userId,
        username: state.username,
        displayName: state.displayName,
        text: cleaned,
        endedAt: Date.now(),
      })
    }
    catch (err: any) {
      log.withError(err).warn('finalizeUtterance failed')
      callbacks.onLog('VOICE_FINALIZE_ERROR', err?.message ?? 'unknown')
    }
    finally {
      // Stream will end after this utterance; the receiver re-fires `speaking start`
      // on the next user activity which we'll re-subscribe in `handleSpeakingStart`.
      const stream = userStreams.get(userId)
      if (stream) {
        stream.closed = true
        userStreams.delete(userId)
        try {
          stream.decoder.destroy()
        }
        catch {}
        try {
          // The opus stream auto-ends; `destroy` is a belt-and-suspenders cleanup.
          stream.opusStream.destroy()
        }
        catch {}
      }
    }
  }

  async function join(
    channel: VoiceBasedChannel,
    config: DiscordVoiceSttConfig,
  ): Promise<{ ok: true, channelName: string } | { ok: false, error: string }> {
    const client = getDiscordClient()
    if (!client?.user) {
      return { ok: false, error: 'Discord client not ready' }
    }

    // Single-connection invariant: tear down any active session before joining a new VC.
    if (connection) {
      try {
        await leave()
      }
      catch { /* noop */ }
    }

    sttConfig = config
    lastError = null

    try {
      connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator as any,
        selfDeaf: false,
        selfMute: false,
      })

      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Ready, 20_000),
        entersState(connection, VoiceConnectionStatus.Signalling, 20_000),
      ])

      activeGuildId = channel.guild.id
      activeChannelId = channel.id
      activeChannelName = channel.name

      audioPlayer = createAudioPlayer({
        behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
      })
      audioPlayer.on('error', (err) => {
        log.withError(err).warn('Audio player error')
      })
      connection.subscribe(audioPlayer)

      // Receiver wiring: we subscribe per-user lazily on `speaking.start` so we
      // never hold an open opus stream for someone who is silent.
      connection.receiver.speaking.on('start', async (userId) => {
        activeSpeakers.add(userId)
        emitState()
        const guild = channel.guild
        const member = guild.members.cache.get(userId) ?? await guild.members.fetch(userId).catch(() => null)
        if (!member || member.user.bot)
          return
        attachUserStream(userId, member.user.username, member.displayName)
      })
      connection.receiver.speaking.on('end', (userId) => {
        activeSpeakers.delete(userId)
        emitState()
      })

      connection.on('stateChange', async (_oldState, newState) => {
        if (newState.status === VoiceConnectionStatus.Disconnected) {
          // Try a brief reconnect; if it fails, treat as a hard disconnect.
          try {
            await Promise.race([
              entersState(connection!, VoiceConnectionStatus.Signalling, 5_000),
              entersState(connection!, VoiceConnectionStatus.Connecting, 5_000),
            ])
          }
          catch {
            log.warn('Voice connection lost; cleaning up')
            await leave().catch(() => {})
          }
        }
        if (newState.status === VoiceConnectionStatus.Destroyed) {
          await leave().catch(() => {})
        }
      })

      connection.on('error', (err) => {
        log.withError(err).warn('Voice connection error')
      })

      emitState()
      return { ok: true, channelName: channel.name }
    }
    catch (err: any) {
      lastError = err?.message ?? 'join failed'
      log.withError(err).error('Failed to join voice channel')
      try {
        connection?.destroy()
      }
      catch { /* noop */ }
      connection = null
      audioPlayer = null
      activeGuildId = null
      activeChannelId = null
      activeChannelName = null
      emitState()
      return { ok: false, error: lastError ?? 'unknown' }
    }
  }

  async function leave() {
    // Tear down all per-user streams first so their `end` events don't fire after
    // we've already cleared `connection` (which would NPE in callbacks).
    for (const stream of userStreams.values()) {
      stream.closed = true
      try {
        stream.decoder.destroy()
      }
      catch {}
      try {
        stream.opusStream.destroy()
      }
      catch {}
    }
    userStreams.clear()
    activeSpeakers.clear()

    if (audioPlayer) {
      try {
        audioPlayer.stop(true)
      }
      catch {}
      audioPlayer.removeAllListeners()
      audioPlayer = null
    }

    if (connection) {
      try {
        connection.removeAllListeners()
        connection.destroy()
      }
      catch { /* noop */ }
      connection = null
    }

    activeGuildId = null
    activeChannelId = null
    activeChannelName = null
    speaking = false
    ttsQueue.length = 0
    ttsDraining = false
    emitState()
  }

  function enqueueTtsAudio(audio: Buffer, mime: string) {
    if (!connection || !audioPlayer) {
      // Quietly drop — caller (renderer) is expected to gate on `state.connected`,
      // but we still want to be tolerant of races.
      return
    }
    ttsQueue.push({ buffer: audio, mime })
    void drainTtsQueue()
  }

  function setSttConfig(config: DiscordVoiceSttConfig) {
    sttConfig = config
  }

  async function destroy() {
    await leave()
  }

  function isConnected() {
    return !!connection && connection.state.status === VoiceConnectionStatus.Ready
  }

  function getState(): DiscordVoiceState {
    return buildState()
  }

  // We also expose the Node-level `getVoiceConnection` lookup as a fallback for
  // external callers that want to know if @discordjs/voice already has state for
  // a guild (e.g. after a hot reload). Not part of the public handle.
  void getVoiceConnection

  return {
    join,
    leave,
    isConnected,
    getState,
    enqueueTtsAudio,
    setSttConfig,
    destroy,
  }
}
