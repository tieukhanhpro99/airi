import type { Buffer } from 'node:buffer'
import type { Readable } from 'node:stream'

import type { AudioPlayer, VoiceConnection, VoiceConnectionState } from '@discordjs/voice'
import type { Logg } from '@guiiai/logg'
import type { Client as AiriClient } from '@proj-airi/server-sdk'
import type { Discord } from '@proj-airi/server-shared/types'
import type {
  BaseGuildVoiceChannel,
  CacheType,
  ChatInputCommandInteraction,
  Client as DiscordClient,
  GuildMember,
} from 'discord.js'

import { EventEmitter } from 'node:events'
import { pipeline } from 'node:stream'

import {
  createAudioPlayer,
  createAudioResource,
  entersState,
  getVoiceConnections,
  joinVoiceChannel,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
} from '@discordjs/voice'
import { useLogg } from '@guiiai/logg'

import { DECODE_SAMPLE_RATE } from '../../../constants/audio'
import { BargeInDetector } from '../../../utils/barge-in-detector'
import { OpusDecoder } from '../../../utils/opus'
import { StreamingTranscriber } from '../../../utils/streaming-transcriber'

async function setSelfVoice(logger: Logg, me?: GuildMember | null) {
  if (me?.voice && me.permissions.has('DeafenMembers')) {
    try {
      await me.voice.setDeaf(false)
      await me.voice.setMute(false)
    }
    catch (error) {
      logger.withError(error).log('Failed to modify voice state') // Continue anyway
    }
  }
}

export class VoiceManager extends EventEmitter {
  private logger = useLogg('VoiceManager').useGlobalConfig()
  private processingVoice: boolean = false

  private activeAudioPlayer: AudioPlayer | null = null
  private bargeInDetector = new BargeInDetector()
  private client: DiscordClient
  private airiClient: AiriClient
  private streams: Map<string, Readable> = new Map()
  private connections: Map<string, VoiceConnection> = new Map()
  private transcribers: Map<string, StreamingTranscriber> = new Map()

  // Track the text channel where the summon command was called, per guild.
  private textChannels: Map<string, string> = new Map()

  // Track event listeners for cleanup
  private connectionListeners: Map<string, {
    stateChange: (oldState: any, newState: any) => Promise<void>
    error: (error: Error) => void
    speakingStart: (userId: string) => void
    speakingEnd: (userId: string) => void
  }> = new Map()

  constructor(client: DiscordClient, airiClient: AiriClient) {
    super()
    this.client = client
    this.airiClient = airiClient
  }

  handleVoiceConnectionStateChange(channel: BaseGuildVoiceChannel, connection: VoiceConnection): (oldState: VoiceConnectionState, newState: VoiceConnectionState) => Promise<void> {
    return async (oldState, newState) => {
      this.logger.withFields({ old: oldState.status, new: newState.status }).log(
        `Voice connection state changed from ${oldState.status} to ${newState.status}`,
      )

      if (newState.status === VoiceConnectionStatus.Destroyed) {
        this.connections.delete(channel.id)
      }
      else if (!this.connections.has(channel.id) && (newState.status === VoiceConnectionStatus.Ready || newState.status === VoiceConnectionStatus.Signalling)) {
        this.connections.set(channel.id, connection)
      }
      else if (newState.status === VoiceConnectionStatus.Disconnected) {
        this.logger.log('Handling disconnection...')

        try {
        // Try to reconnect if disconnected
          await Promise.race([
            entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
            entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
          ])
          // Seems to be reconnecting to a new channel
          this.logger.log('Reconnecting to channel...')
        }
        catch (e) {
        // Seems to be a real disconnect, destroy and cleanup
          this.logger.log(`Disconnection confirmed - cleaning up...${e}`)
          connection.destroy()
          this.connections.delete(channel.id)
        }
      }
    }
  }

  handleVoiceConnectionError(error: unknown) {
    this.logger.withError(error).log('Voice connection error')
    // Don't immediately destroy - let the state change handler deal with it
    this.logger.log('Connection error - will attempt to recover...')
  }

  handleAudioReceiveStreamStart(channel: BaseGuildVoiceChannel): (userId: string) => Promise<void> {
    return async (userId) => {
      let user = channel.members.get(userId)
      if (!user) {
        try {
          user = await channel.guild.members.fetch(userId)
        }
        catch (error) {
          this.logger.withError(error).error('Failed to fetch user')
        }
      }
      if (user && !user?.user.bot) {
        this.logger.log(`User speaking: ${user.displayName}`)
        this.monitorMember(user as GuildMember, channel.id)
        this.streams.get(userId)?.emit('speakingStarted')
      }
    }
  }

  handleAudioReceiveStreamEnd(channel: BaseGuildVoiceChannel): (userId: string) => void {
    return async (userId: string) => {
      const user = channel.members.get(userId)
      if (!user?.user.bot) {
        this.logger.log(`User stopped speaking: ${user.displayName}`)
        this.streams.get(userId)?.emit('speakingStopped')
      }
    }
  }

  async joinChannel(interaction: ChatInputCommandInteraction<CacheType>, channel: BaseGuildVoiceChannel) {
    const oldConnection = this.getVoiceConnection(
      channel.guildId as string,
    )
    if (oldConnection) {
      try {
        oldConnection.destroy()
        // Remove all associated streams and transcribers
        this.streams.clear()
        for (const [id, transcriber] of this.transcribers) {
          transcriber.destroy()
          this.transcribers.delete(id)
        }
      }
      catch (error) {
        this.logger.withError(error).log('Error leaving voice channel')
      }
    }

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator as any,
      selfDeaf: false,
      selfMute: false,
      group: this.client.user.id,
    })

    try {
      // Wait for either Ready or Signalling state
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Ready, 20_000),
        entersState(connection, VoiceConnectionStatus.Signalling, 20_000),
      ])

      // Log connection success
      this.logger.withField('state', connection.state.status).log('Voice connection established in state')
      await interaction.reply(`Joined: ${channel.name}.`)

      // Store the text channel context for this guild
      if (interaction.guildId) {
        this.textChannels.set(interaction.guildId, interaction.channelId)
      }

      // Set up ongoing state change monitoring
      connection.on('stateChange', this.handleVoiceConnectionStateChange(channel, connection))
      connection.on('error', this.handleVoiceConnectionError)

      // Store the connection
      this.connections.set(channel.id, connection)

      connection.receiver.speaking.on('start', this.handleAudioReceiveStreamStart(channel))
      connection.receiver.speaking.on('end', this.handleAudioReceiveStreamEnd(channel))

      // Continue with voice state modifications
      await setSelfVoice(this.logger, channel.guild.members.me)
    }
    catch (error) {
      this.logger.log('Failed to establish voice connection:', error)

      connection.destroy()
      this.connections.delete(channel.id)
      throw error
    }
  }

  private getVoiceConnection(guildId: string) {
    const connections = getVoiceConnections(this.client.user.id)
    if (!connections) {
      this.logger.warn('No voice connections found')
      return
    }
    const connection = [...connections.values()].find(
      connection => connection.joinConfig.guildId === guildId,
    )
    if (!connection) {
      this.logger.warn('No voice connection found for guild')
    }

    return connection
  }

  private async monitorMember(
    member: GuildMember,
    channelId: string,
  ) {
    const userId = member?.id
    const connection = this.getVoiceConnection(member?.guild?.id)
    const receiveStream = connection?.receiver.subscribe(userId, {
      autoDestroy: true,
      emitClose: true,
    })
    if (!receiveStream) {
      this.logger.warn('No voice data received')
      return
    }

    const opusDecoder = new OpusDecoder(DECODE_SAMPLE_RATE, 1)

    // ── Barge-in: detect user speaking over bot's TTS playback ───────────
    const bargeInHandler = (pcmData: Buffer) => {
      if (this.activeAudioPlayer) {
        const triggered = this.bargeInDetector.process(pcmData)
        if (triggered) {
          this.logger.log(`Barge-in from ${member.displayName} — stopping playback`)
          this.cleanupAudioPlayer(this.activeAudioPlayer)
          this.processingVoice = false
          // Notify AIRI that the response was interrupted
          this.emit('barge-in', { userId, displayName: member.displayName })
        }
      }
      else {
        // Reset detector state when bot is not playing
        this.bargeInDetector.reset()
      }
    }

    // ── Streaming STT: send audio chunks to speaches in realtime ─────────
    const guildId = member.guild.id
    const transcriber = new StreamingTranscriber({
      onTranscript: (text) => {
        // Use the text channel where /summon was called, fallback to voice channel
        const targetChannelId = (guildId && this.textChannels.has(guildId))
          ? this.textChannels.get(guildId)!
          : channelId

        const discordContext = {
          channelId: targetChannelId,
          guildId,
          guildMember: member,
        } satisfies Discord

        this.logger.log(`[StreamingSTT] "${text}" from ${member.displayName}`)

        this.airiClient.send({
          type: 'input:text:voice',
          data: { transcription: text, discord: discordContext },
        })

        this.airiClient.send({
          type: 'input:text',
          data: { text, discord: discordContext },
        })
      },
      onSpeechStart: () => {
        // If bot is playing and user starts speaking, the barge-in handler
        // will take care of stopping playback. Here we just log.
        this.logger.log(`Speech start: ${member.displayName}`)
      },
      onSpeechEnd: () => {
        this.logger.log(`Speech end: ${member.displayName}`)
      },
    })

    // Store transcriber for cleanup
    this.transcribers.set(userId, transcriber)

    this.streams.set(userId, opusDecoder)
    this.connections.set(userId, connection as VoiceConnection)

    // Wire up barge-in detection on every PCM frame
    opusDecoder.on('data', bargeInHandler)

    // Attach streaming transcriber to the decoded PCM stream
    transcriber.attach(opusDecoder)

    const errorHandler = err => this.logger.withError(err).error('Opus decoding error')
    const streamCloseHandler = () => {
      this.logger.withField('displayName', member?.displayName).log('Voice stream closed')
      this.streams.delete(userId)
      this.connections.delete(userId)
      this.transcribers.get(userId)?.destroy()
      this.transcribers.delete(userId)
    }
    const closeHandler = () => {
      this.logger.withField('displayName', member?.displayName).log('Opus decoder closed')
      opusDecoder.removeListener('data', bargeInHandler)
      opusDecoder.removeListener('error', errorHandler)
      opusDecoder.removeListener('close', closeHandler)
      receiveStream?.removeListener('close', streamCloseHandler)
    }

    opusDecoder.on('error', errorHandler)
    opusDecoder.on('close', closeHandler)
    receiveStream?.on('close', streamCloseHandler)

    pipeline(receiveStream, opusDecoder, (err) => {
      if (err) {
        this.logger.withError(err).error('Opus decoding pipeline error')
        if (err.message.includes('memory access out of bounds')) {
          throw err
        }
      }
    })

    this.logger.log(`Monitoring user: ${member.displayName} (streaming STT + barge-in)`)
  }

  leaveChannel(channel: BaseGuildVoiceChannel) {
    const connection = this.connections.get(channel.id)

    if (connection) {
      // Remove event listeners to prevent memory leaks
      const listeners = this.connectionListeners.get(channel.id)
      if (listeners) {
        connection.off('stateChange', listeners.stateChange)
        connection.off('error', listeners.error)
        connection.receiver.speaking.off('start', listeners.speakingStart)
        connection.receiver.speaking.off('end', listeners.speakingEnd)
        this.connectionListeners.delete(channel.id)
      }

      connection.destroy()
      this.connections.delete(channel.id)
    }

    // Destroy all transcribers and streams
    for (const [memberId, transcriber] of this.transcribers) {
      transcriber.destroy()
      this.transcribers.delete(memberId)
    }
    this.streams.clear()

    this.logger.log(`Left voice channel: ${channel.name} (${channel.id})`)
  }

  async playAudioStream(userId: string, audioStream: Readable) {
    const connection = this.connections.get(userId)
    if (connection == null) {
      this.logger.log(`No connection for user ${userId}`)
      return
    }

    this.cleanupAudioPlayer(this.activeAudioPlayer)
    const audioPlayer = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Pause,
      },
    })

    this.activeAudioPlayer = audioPlayer
    connection.subscribe(audioPlayer)

    const audioStartTime = Date.now()
    const resource = createAudioResource(audioStream, {
      inputType: StreamType.Arbitrary,
    })

    audioPlayer.on('error', error => this.logger.withError(error).log('Audio player error'))
    audioPlayer.on('stateChange', (_oldState: any, newState: { status: string }) => {
      if (newState.status === 'idle') {
        const idleTime = Date.now()
        this.logger.withField('elapsed', idleTime - audioStartTime).log(`Audio playback done`)
      }
    })

    audioPlayer.play(resource)
  }

  cleanupAudioPlayer(audioPlayer: AudioPlayer) {
    if (!audioPlayer)
      return

    audioPlayer.stop()
    audioPlayer.removeAllListeners()
    if (audioPlayer === this.activeAudioPlayer) {
      this.activeAudioPlayer = null
    }
  }

  async handleJoinChannelCommand(interaction: ChatInputCommandInteraction<CacheType>) {
    try {
      const currVoiceChannel = (interaction.member as GuildMember).voice.channel
      if (!currVoiceChannel) {
        return await interaction.reply('Please join a voice channel first.')
      }

      await this.joinChannel(interaction, currVoiceChannel)
    }
    catch (error) {
      this.logger.withError(error).log('Error joining voice channel')
    }
  }

  async handleLeaveChannelCommand(interaction: any) {
    const connection = this.getVoiceConnection(interaction.guildId as any)

    if (!connection) {
      await interaction.reply('Not currently in a voice channel.')
      return
    }

    try {
      connection.destroy()
      await interaction.reply('Left the voice channel.')
    }
    catch (error) {
      this.logger.withError(error).log('Error leaving voice channel')

      await interaction.reply('Failed to leave the voice channel.')
    }
  }
}
