import type {
  DiscordEventLogEntry,
  DiscordInboundMessage,
  DiscordInteractionPayload,
  DiscordOutboundImage,
  DiscordServiceStatus,
  DiscordVoiceState,
} from '@proj-airi/stage-shared'

import { useLogg } from '@guiiai/logg'
import { defineInvokeHandler } from '@moeru/eventa'
import { createContext } from '@moeru/eventa/adapters/electron/main'
import { Client, Events, GatewayIntentBits, Partials } from 'discord.js'
import { BrowserWindow, ipcMain } from 'electron'
import { nanoid } from 'nanoid'

import {
  discordServiceForceSync,
  discordServiceGetStatus,
  discordServiceRegisterCommands,
  discordServiceReplyInteraction,
  discordServiceSendMessage,
  discordServiceSendTyping,
  discordServiceSimulateEvent,
  discordServiceStart,
  discordServiceStop,
  discordVoiceGetState,
  discordVoiceJoinByInteraction,
  discordVoiceLeave,
  discordVoiceLeaveByInteraction,
  discordVoiceUpdateSttConfig,
} from '../../../../shared/eventa'
import { createVoiceManager } from './voice'

const log = useLogg('discord-service').useGlobalConfig()

// Event channel names for main → renderer push events
const STATUS_CHANGED_CHANNEL = 'eventa:event:electron:discord:status-changed'
const EVENT_LOG_CHANNEL = 'eventa:event:electron:discord:event-log'
const INBOUND_MESSAGE_CHANNEL = 'eventa:event:electron:discord:inbound-message'
const INTERACTION_CHANNEL = 'eventa:event:electron:discord:interaction'
const VOICE_STATE_CHANNEL = 'eventa:event:electron:discord:voice:state-changed'
const VOICE_TRANSCRIPT_CHANNEL = 'eventa:event:electron:discord:voice:transcript-created'

// ── Internal State ─────────────────────────────────────────────────────────────

let discordClient: Client | null = null
let activeChannelId: string | null = null
const activeInteractions = new Map<string, any>()
let lastError: string | null = null
let voiceManager: ReturnType<typeof createVoiceManager> | null = null

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Broadcast an event payload to all BrowserWindows. */
function broadcastToAllWindows(channel: string, payload: unknown) {
  // Use setImmediate to avoid blocking the main thread during heavy broadcast cycles
  setImmediate(() => {
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
          win.webContents.send(channel, payload)
        }
      }
      catch (err: any) {
        // NOTICE: We ignore 'Render frame was disposed' errors as they occur normally
        // when a window is closed or crashes while a broadcast is in flight.
        const msg = err?.message || ''
        if (!msg.includes('disposed') && !msg.includes('WebFrameMain')) {
          log.warn(`Broadcast failed for window ${win.id}: ${msg}`)
        }
      }
    }
  })
}

function buildStatus(): DiscordServiceStatus {
  if (!discordClient) {
    return {
      state: 'disconnected',
      ping: null,
      guilds: [],
      activeChannelId: null,
      botUser: null,
      error: lastError,
    }
  }

  const ready = discordClient.isReady()
  const guilds = ready
    ? discordClient.guilds.cache.map(g => ({
        id: g.id,
        name: g.name,
        icon: g.iconURL({ size: 64 }),
      }))
    : []

  return {
    state: ready ? 'connected' : 'connecting',
    ping: ready ? discordClient.ws.ping : null,
    guilds,
    activeChannelId,
    botUser: ready && discordClient.user
      ? {
          id: discordClient.user.id,
          tag: discordClient.user.tag,
          avatarUrl: discordClient.user.displayAvatarURL({ size: 128 }),
        }
      : null,
    error: lastError,
  }
}

/**
 * Split a message into Discord-safe chunks (≤2000 chars), preferring
 * newline and space boundaries.  Ported from the legacy adapter.
 */
function chunkMessage(content: string): string[] {
  const MAX = 2000
  if (content.length <= MAX)
    return [content]

  const chunks: string[] = []
  let remaining = content

  while (remaining.length > 0) {
    if (remaining.length <= MAX) {
      chunks.push(remaining)
      break
    }

    let splitAt = remaining.lastIndexOf('\n', MAX)
    if (splitAt <= 0)
      splitAt = remaining.lastIndexOf(' ', MAX)
    if (splitAt <= 0)
      splitAt = MAX

    chunks.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt).trim()
  }

  return chunks
}

// ── Service Setup ──────────────────────────────────────────────────────────────

export function setupDiscordService() {
  const { context } = createContext(ipcMain)

  // ── Interaction Logic ──────────────────────────────────────────────────

  const handleInteraction = async (interaction: any) => {
    if (!interaction.isChatInputCommand())
      return

    try {
      pushLog('INTERACTION', `Received /${interaction.commandName} from ${interaction.user.tag}`)

      // 1. Defer the reply immediately to satisfy the 3s timeout
      await interaction.deferReply()

      // 2. Cache the interaction so the renderer can reply to it later
      activeInteractions.set(interaction.id, interaction)

      // 3. Extract options into a simple key-value map
      const options: Record<string, any> = {}
      interaction.options.data.forEach((opt: any) => {
        options[opt.name] = opt.value
      })

      // 4. Forward to Renderer
      pushInteraction({
        interactionId: interaction.id,
        commandName: interaction.commandName,
        options,
        channelId: interaction.channelId,
        userId: interaction.user.id,
        username: interaction.user.username,
      })

      // 5. Auto-cleanup interactions after 15 minutes (Discord's token limit)
      setTimeout(() => {
        activeInteractions.delete(interaction.id)
      }, 15 * 60 * 1000)
    }
    catch (err: any) {
      pushLog('ERROR', `Interaction handling failed: ${err.message}`)
    }
  }

  function pushLog(type: string, summary: string) {
    const entry: DiscordEventLogEntry = {
      timestamp: Date.now(),
      type,
      summary,
    }
    log.log(`[Event] ${type}: ${summary}`)
    broadcastToAllWindows(EVENT_LOG_CHANNEL, entry)
  }

  function pushStatus() {
    broadcastToAllWindows(STATUS_CHANGED_CHANNEL, buildStatus())
  }

  function pushInboundMessage(msg: DiscordInboundMessage) {
    broadcastToAllWindows(INBOUND_MESSAGE_CHANNEL, msg)
  }

  function pushInteraction(payload: DiscordInteractionPayload) {
    broadcastToAllWindows(INTERACTION_CHANNEL, payload)
  }

  // ── Invoke Handlers ────────────────────────────────────────────────────────

  defineInvokeHandler(context, discordServiceStart, async (payload) => {
    const token = payload?.token
    if (!token) {
      lastError = 'No token provided'
      pushStatus()
      return buildStatus()
    }

    // Tear down existing client if any
    if (discordClient) {
      try {
        discordClient.removeAllListeners()
        await discordClient.destroy()
      }
      catch { /* ignore */ }
      discordClient = null
    }

    lastError = null
    pushLog('SERVICE', 'Starting Discord service...')

    discordClient = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel],
    })

    // ── Discord Event Wiring ───────────────────────────────────────────────

    discordClient.once(Events.ClientReady, (readyClient) => {
      log.log(`Discord bot ready: ${readyClient.user.tag}`)
      pushLog('READY', `Bot online as ${readyClient.user.tag}`)
      pushStatus()
    })

    discordClient.on(Events.ShardDisconnect, (_, shardId) => {
      pushLog('SHARD_DISCONNECT', `Shard ${shardId} disconnected`)
      pushStatus()
    })

    discordClient.on(Events.ShardReconnecting, (shardId) => {
      pushLog('SHARD_RECONNECTING', `Shard ${shardId} reconnecting...`)
      pushStatus()
    })

    discordClient.on(Events.ShardReady, (shardId) => {
      pushLog('SHARD_READY', `Shard ${shardId} ready`)
      pushStatus()
    })

    discordClient.on(Events.Error, (error) => {
      lastError = error.message
      pushLog('ERROR', error.message)
      pushStatus()
    })

    // ── Inbound Message Pipe ───────────────────────────────────────────────

    discordClient.on(Events.MessageCreate, async (message) => {
      if (message.author.bot)
        return

      const content = message.content.trim()

      // Allow empty text if there are attachments
      if (!content && message.attachments.size === 0)
        return

      // Track active channel for outbound routing
      activeChannelId = message.channelId

      pushLog('MESSAGE_CREATE', `${message.author.username}: ${content.substring(0, 80)}${content.length > 80 ? '...' : ''} (${message.attachments.size} attachments)`)

      const inbound: DiscordInboundMessage = {
        messageId: message.id,
        channelId: message.channelId,
        guildId: message.guildId ?? null,
        guildName: message.guild?.name ?? null,
        userId: message.author.id,
        username: message.author.username,
        displayName: message.member?.displayName ?? message.author.username,
        content,
        attachments: [],
      }

      // Handle image attachments
      if (message.attachments.size > 0) {
        for (const attachment of message.attachments.values()) {
          if (attachment.contentType?.startsWith('image/')) {
            try {
              pushLog('ATTACHMENT', `Downloading ${attachment.name} (${attachment.contentType})...`)
              const response = await fetch(attachment.url)
              const buffer = await response.arrayBuffer()
              const base64 = Buffer.from(buffer).toString('base64')
              inbound.attachments.push(`data:${attachment.contentType};base64,${base64}`)
            }
            catch (err: any) {
              pushLog('ERROR', `Failed to download attachment: ${err.message}`)
            }
          }
        }
      }

      pushInboundMessage(inbound)
    })

    discordClient.on(Events.InteractionCreate, handleInteraction)

    // ── Voice Manager Wiring ──────────────────────────────────────────────

    voiceManager = createVoiceManager({
      getDiscordClient: () => discordClient,
      callbacks: {
        onStateChange: (state) => {
          broadcastToAllWindows(VOICE_STATE_CHANNEL, state)
        },
        onTranscript: (transcript) => {
          broadcastToAllWindows(VOICE_TRANSCRIPT_CHANNEL, transcript)
        },
        onLog: (type, summary) => pushLog(type, summary),
      },
    })

    // ── Login ──────────────────────────────────────────────────────────────

    try {
      pushStatus() // connecting state
      await discordClient.login(token)
      return buildStatus()
    }
    catch (err: any) {
      lastError = err?.message || 'Login failed'
      pushLog('ERROR', `Login failed: ${lastError}`)
      pushStatus()
      return buildStatus()
    }
  })

  defineInvokeHandler(context, discordServiceStop, async () => {
    if (voiceManager) {
      try {
        await voiceManager.destroy()
      }
      catch { /* ignore */ }
      voiceManager = null
    }
    if (discordClient) {
      pushLog('SERVICE', 'Stopping Discord service...')
      try {
        discordClient.removeAllListeners()
        await discordClient.destroy()
      }
      catch { /* ignore */ }
      discordClient = null
      activeChannelId = null
    }
    pushStatus()
    return buildStatus()
  })

  defineInvokeHandler(context, discordServiceGetStatus, async () => {
    return buildStatus()
  })

  // ── Outbound: Send assistant message to Discord ────────────────────────

  defineInvokeHandler(context, discordServiceSendMessage, async (payload) => {
    if (!discordClient?.isReady() || !payload?.channelId || !payload?.content)
      return

    try {
      const channel = await discordClient.channels.fetch(payload.channelId)
      if (channel?.isTextBased() && 'send' in channel && typeof (channel as any).send === 'function') {
        const chunks = chunkMessage(payload.content)
        for (const chunk of chunks) {
          await (channel as any).send(chunk)
        }
        pushLog('MESSAGE_SEND', `Sent ${chunks.length} chunk(s) to ${payload.channelId}`)
      }
    }
    catch (err: any) {
      pushLog('ERROR', `Failed to send message: ${err?.message}`)
    }
  })

  // ── Outbound: Send typing indicator to Discord ────────────────────────

  defineInvokeHandler(context, discordServiceSendTyping, async (payload) => {
    if (!discordClient?.isReady() || !payload?.channelId)
      return

    try {
      const channel = await discordClient.channels.fetch(payload.channelId)
      if (channel?.isTextBased() && 'sendTyping' in channel && typeof (channel as any).sendTyping === 'function') {
        await (channel as any).sendTyping()
        // We don't push log for typing to avoid spamming the debug console
      }
    }
    catch {
      // Ignore typing errors silently to avoid spam
    }
  })

  // ── Native IPC Bypass ───────────────────────────────────────────────────
  // We use native ipcMain.handle for images because the Eventa Context Bridge (WebSocket)
  // often has a 1MB payload limit that chokes on high-res base64 strings.
  // Electron's native IPC can handle hundreds of megabytes without breaking.
  ipcMain.handle('eventa:invoke:electron:discord:send-image', async (_event, payload: DiscordOutboundImage) => {
    // 0. Hard Terminal Log (Visible in the shell where AIRI started)
    console.log(`[DiscordService/Native] IPC Received Image. Size: ${Math.round((payload?.base64?.length || 0) / 1024)}KB, Shape: ${payload?.base64?.substring(0, 30)}...`)

    // 0. UI Receipt Log
    pushLog('IMAGE_PUSH', `IPC Received: Image Payload (${Math.round((payload?.base64?.length || 0) / 1024)}KB)`)

    if (!discordClient?.isReady() || !payload?.channelId || !payload?.base64) {
      pushLog('ERROR', `SendImage skipped: ClientReady=${discordClient?.isReady()}, Channel=${payload?.channelId}`)
      return { success: false, error: 'Client not ready or invalid payload' }
    }

    try {
      pushLog('IMAGE_PUSH', `Fetching channel ${payload.channelId}...`)
      const channel = await discordClient.channels.fetch(payload.channelId)

      if (channel?.isTextBased() && 'send' in channel && typeof (channel as any).send === 'function') {
        pushLog('IMAGE_PUSH', `Converting base64 buffer (${Math.round(payload.base64.length / 1024)}KB)...`)

        let base64Data = payload.base64
        if (base64Data.startsWith('data:')) {
          base64Data = base64Data.split(',')[1]
        }

        const buffer = Buffer.from(base64Data, 'base64')

        pushLog('IMAGE_PUSH', `Attempting Discord send to ${payload.channelId}...`)
        await (channel as any).send({
          content: payload.content || null,
          files: [{
            attachment: buffer,
            name: payload.filename || 'airi-manifestation.png',
          }],
        })
        pushLog('IMAGE_SEND', `Successfully sent image to ${payload.channelId} (Native Bypass)`)
        return { success: true }
      }
      else {
        pushLog('ERROR', `Channel ${payload.channelId} is not text-based or lacks send()`)
        return { success: false, error: 'Invalid channel type' }
      }
    }
    catch (err: any) {
      pushLog('ERROR', `Failed to send image: ${err?.message || 'Unknown Error'}`)
      console.error('[DiscordService/Native] sendImage Error:', err)
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('eventa:invoke:electron:discord:send-voice-note', async (_event, payload: { channelId: string, audioBuffers: Uint8Array[], content?: string, filename?: string }) => {
    // 0. Hard Terminal Log
    console.log(`[DiscordService/Native] IPC Received Voice Note. Chunks: ${payload?.audioBuffers?.length}, Total Chunks: ${payload?.audioBuffers?.length}`)

    if (!discordClient?.isReady() || !payload?.channelId || !payload?.audioBuffers || payload.audioBuffers.length === 0) {
      pushLog('ERROR', `SendVoiceNote skipped: ClientReady=${discordClient?.isReady()}, Channel=${payload?.channelId}, BufferCount=${payload?.audioBuffers?.length}`)
      return { success: false, error: 'Client not ready or empty buffers' }
    }

    try {
      pushLog('VOICE_PUSH', `Fetching channel ${payload.channelId} for voice note...`)
      const channel = await discordClient.channels.fetch(payload.channelId)

      if (channel?.isTextBased() && 'send' in channel && typeof (channel as any).send === 'function') {
        pushLog('VOICE_PUSH', `Merging ${payload.audioBuffers.length} audio chunks...`)

        // In Electron IPC, ArrayBuffers/Uint8Arrays come across as Uint8Arrays.
        // We can use Buffer.concat directly after wrapping them.
        const buffer = Buffer.concat(payload.audioBuffers.map(b => Buffer.from(b)))

        pushLog('VOICE_PUSH', `Attempting Discord send to ${payload.channelId} (Size: ${Math.round(buffer.length / 1024)}KB)...`)
        await (channel as any).send({
          content: payload.content || null,
          files: [{
            attachment: buffer,
            name: payload.filename || 'voice-note.mp3',
          }],
        })
        pushLog('VOICE_SEND', `Successfully sent voice note to ${payload.channelId} (Native Bypass)`)
        return { success: true }
      }
      else {
        pushLog('ERROR', `Channel ${payload.channelId} is not text-based or lacks send()`)
        return { success: false, error: 'Invalid channel type' }
      }
    }
    catch (err: any) {
      pushLog('ERROR', `Failed to send voice note: ${err?.message || 'Unknown Error'}`)
      console.error('[DiscordService/Native] sendVoiceNote Error:', err)
      return { success: false, error: err.message }
    }
  })

  // ── Force Sync: Push AIRI Card identity to Discord ─────────────────────

  defineInvokeHandler(context, discordServiceForceSync, async (payload) => {
    if (!discordClient?.isReady() || !discordClient.user)
      return

    try {
      const updates: any = {}
      if (payload?.name)
        updates.username = payload.name
      if (payload?.avatarBase64)
        updates.avatar = payload.avatarBase64

      if (Object.keys(updates).length > 0) {
        await discordClient.user.edit(updates)
        pushLog('FORCE_SYNC', `Updated bot profile: ${JSON.stringify(Object.keys(updates))}`)
      }
    }
    catch (err: any) {
      pushLog('ERROR', `Force sync failed: ${err?.message}`)
    }
  })

  // ── Simulate: Inject a mock inbound message ────────────────────────────

  defineInvokeHandler(context, discordServiceSimulateEvent, async (payload) => {
    const mock: DiscordInboundMessage = {
      messageId: `sim-${nanoid()}`,
      channelId: activeChannelId || 'simulated-channel',
      guildId: null,
      guildName: null,
      userId: 'simulated-user-001',
      username: payload?.username || 'TestUser',
      displayName: payload?.username || 'TestUser',
      content: payload?.content || 'Hello from simulated event!',
      attachments: [],
    }

    pushLog('SIMULATE', `Injected mock message from ${mock.username}: ${mock.content.substring(0, 60)}`)
    pushInboundMessage(mock)
  })

  // ── Registration: Slash Commands ───────────────────────────────────────

  defineInvokeHandler(context, discordServiceRegisterCommands, async (payload) => {
    if (!discordClient?.isReady() || !discordClient.application) {
      throw new Error('Discord client not ready for command registration')
    }

    try {
      pushLog('COMMAND_REG', `Registering ${payload.commands.length} global commands...`)
      await discordClient.application.commands.set(payload.commands)
      pushLog('COMMAND_REG', 'Commands registered successfully')
    }
    catch (err: any) {
      pushLog('ERROR', `Command registration failed: ${err.message}`)
      throw err
    }
  })

  defineInvokeHandler(context, discordServiceReplyInteraction, async (payload) => {
    const interaction = activeInteractions.get(payload.interactionId)
    if (!interaction) {
      pushLog('ERROR', `Cannot reply: Interaction ${payload.interactionId} not found or expired`)
      return
    }

    try {
      if (payload.followUp) {
        await interaction.followUp({ content: payload.content, ephemeral: payload.ephemeral })
      }
      else {
        await interaction.editReply({ content: payload.content })
      }
    }
    catch (err: any) {
      pushLog('ERROR', `Failed to reply to interaction: ${err.message}`)
    }
  })

  // ── Voice Invoke Handlers ──────────────────────────────────────────────

  defineInvokeHandler(context, discordVoiceJoinByInteraction, async (payload) => {
    const fallbackState: DiscordVoiceState = voiceManager?.getState() ?? {
      connected: false,
      speaking: false,
      guildId: null,
      channelId: null,
      channelName: null,
      lastError: null,
      activeSpeakers: [],
    }

    if (!discordClient?.isReady()) {
      return { ok: false, error: 'Discord client not ready', state: fallbackState }
    }
    if (!voiceManager) {
      return { ok: false, error: 'Voice manager not initialized', state: fallbackState }
    }

    const interaction = activeInteractions.get(payload.interactionId)
    if (!interaction) {
      return { ok: false, error: 'Interaction expired', state: fallbackState }
    }

    // Resolve the user's current voice channel from the interaction's GuildMember.
    const member = interaction.member as { voice?: { channel?: { id: string, name: string, guild: any } } } | undefined
    const channel = member?.voice?.channel
    if (!channel) {
      return { ok: false, error: 'You must be in a voice channel first', state: fallbackState }
    }

    pushLog('VOICE_JOIN', `Joining voice channel "${channel.name}"...`)
    const result = await voiceManager.join(channel as any, payload.stt)
    if (!result.ok) {
      pushLog('VOICE_JOIN_FAIL', result.error)
      return { ok: false, error: result.error, state: voiceManager.getState() }
    }

    pushLog('VOICE_JOIN_OK', `Joined "${result.channelName}"`)
    return { ok: true, state: voiceManager.getState() }
  })

  defineInvokeHandler(context, discordVoiceLeaveByInteraction, async (_payload) => {
    const fallbackState: DiscordVoiceState = voiceManager?.getState() ?? {
      connected: false,
      speaking: false,
      guildId: null,
      channelId: null,
      channelName: null,
      lastError: null,
      activeSpeakers: [],
    }

    if (!voiceManager) {
      return { ok: false, error: 'Voice manager not initialized', state: fallbackState }
    }

    pushLog('VOICE_LEAVE', 'Leaving voice channel by interaction...')
    await voiceManager.leave()
    return { ok: true, state: voiceManager.getState() }
  })

  defineInvokeHandler(context, discordVoiceLeave, async () => {
    if (!voiceManager) {
      return {
        connected: false,
        speaking: false,
        guildId: null,
        channelId: null,
        channelName: null,
        lastError: null,
        activeSpeakers: [],
      }
    }
    await voiceManager.leave()
    return voiceManager.getState()
  })

  defineInvokeHandler(context, discordVoiceUpdateSttConfig, async (payload) => {
    if (voiceManager && payload?.stt) {
      voiceManager.setSttConfig(payload.stt)
    }
  })

  defineInvokeHandler(context, discordVoiceGetState, async () => {
    return voiceManager?.getState() ?? {
      connected: false,
      speaking: false,
      guildId: null,
      channelId: null,
      channelName: null,
      lastError: null,
      activeSpeakers: [],
    }
  })

  // ── Native IPC Bypass: TTS audio chunks for active voice channel ──────────
  // Renderer ships per-sentence TTS buffers (mp3 from vieneutts) here so we can
  // transcode → push to the active VoiceConnection's AudioPlayer.

  ipcMain.handle('eventa:invoke:electron:discord:voice:enqueue-tts', async (_event, payload: { audio: Uint8Array, mime?: string }) => {
    if (!voiceManager?.isConnected()) {
      return { success: false, error: 'voice not connected' }
    }
    if (!payload?.audio || payload.audio.byteLength === 0) {
      return { success: false, error: 'empty audio' }
    }

    try {
      const buf = Buffer.from(payload.audio)
      voiceManager.enqueueTtsAudio(buf, payload.mime ?? 'audio/mpeg')
      return { success: true }
    }
    catch (err: any) {
      pushLog('VOICE_TTS_FAIL', err?.message ?? 'unknown')
      return { success: false, error: err?.message ?? 'unknown' }
    }
  })

  log.log('Discord service handlers registered')
}
