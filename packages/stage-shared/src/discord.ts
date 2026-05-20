import { defineEventa, defineInvokeEventa } from '@moeru/eventa'

// ── Types ──────────────────────────────────────────────────────────────────────

export interface DiscordGuildInfo {
  id: string
  name: string
  icon: string | null
}

export interface DiscordServiceStatus {
  state: 'disconnected' | 'connecting' | 'connected' | 'error'
  ping: number | null
  guilds: DiscordGuildInfo[]
  activeChannelId: string | null
  botUser: { id: string, tag: string, avatarUrl: string | null } | null
  error: string | null
}

export interface DiscordEventLogEntry {
  timestamp: number
  type: string
  summary: string
}

export interface DiscordInboundMessage {
  messageId: string
  channelId: string
  guildId: string | null
  guildName: string | null
  userId: string
  username: string
  displayName: string
  content: string
  /** If the user attached images, base64-encoded data URIs */
  attachments: string[]
}

export interface DiscordOutboundMessage {
  channelId: string
  content: string
}

export interface DiscordForceSyncPayload {
  name: string
  avatarBase64: string | null
}

export interface DiscordSimulatePayload {
  username: string
  content: string
}

export interface DiscordCommandOption {
  type: number // 3 for string, 4 for integer, etc.
  name: string
  description: string
  required?: boolean
  choices?: Array<{ name: string, value: string | number }>
  autocomplete?: boolean
}

export interface DiscordCommandDefinition {
  name: string
  description: string
  options?: DiscordCommandOption[]
}

/** Payload for interaction events from Main to Renderer */
export interface DiscordInteractionPayload {
  interactionId: string
  commandName: string
  options: Record<string, any>
  channelId: string
  userId: string
  username: string
}

/** Payload for replying to an interaction from Renderer to Main */
export interface DiscordInteractionReplyPayload {
  interactionId: string
  content: string
  /** If true, sends as a follow-up if the initial reply was already sent */
  followUp?: boolean
  /** If true, only visible to the user who triggered it */
  ephemeral?: boolean
}

// ── Invoke Contracts (Renderer → Main) ─────────────────────────────────────────

/** Start the Discord service with the stored bot token. */
export const discordServiceStart = defineInvokeEventa<DiscordServiceStatus, { token: string }>(
  'eventa:invoke:electron:discord:start',
)

/** Stop the Discord service and disconnect the bot. */
export const discordServiceStop = defineInvokeEventa<DiscordServiceStatus>(
  'eventa:invoke:electron:discord:stop',
)

/** Poll the current service status (connection, ping, guilds). */
export const discordServiceGetStatus = defineInvokeEventa<DiscordServiceStatus>(
  'eventa:invoke:electron:discord:get-status',
)

/** Push the current AIRI Card identity (name/avatar) to the Discord bot profile. */
export const discordServiceForceSync = defineInvokeEventa<void, DiscordForceSyncPayload>(
  'eventa:invoke:electron:discord:force-sync',
)

/** Inject a mock inbound message to test the full pipeline. */
export const discordServiceSimulateEvent = defineInvokeEventa<void, DiscordSimulatePayload>(
  'eventa:invoke:electron:discord:simulate-event',
)

/** Send a message from the assistant to a Discord channel. */
export const discordServiceSendMessage = defineInvokeEventa<void, DiscordOutboundMessage>(
  'eventa:invoke:electron:discord:send-message',
)

/** Send a typing indicator to a Discord channel. */
export const discordServiceSendTyping = defineInvokeEventa<void, { channelId: string }>(
  'eventa:invoke:electron:discord:send-typing',
)

/** Register global slash commands with the Discord API. */
export const discordServiceRegisterCommands = defineInvokeEventa<void, { commands: DiscordCommandDefinition[] }>(
  'eventa:invoke:electron:discord:register-commands',
)

/** Reply to a deferred interaction. */
export const discordServiceReplyInteraction = defineInvokeEventa<void, DiscordInteractionReplyPayload>(
  'eventa:invoke:electron:discord:reply-interaction',
)

export interface DiscordOutboundImage {
  channelId: string
  content?: string
  base64: string
  filename?: string
}

/** Send an image (base64) from the assistant to a Discord channel. */
export const discordServiceSendImage = defineInvokeEventa<void, DiscordOutboundImage>(
  'eventa:invoke:electron:discord:send-image',
)

// ── Event Contracts (Main → Renderer, push-based) ──────────────────────────────

/** Emitted when the service connection state changes. */
export const discordServiceStatusChanged = defineEventa<DiscordServiceStatus>(
  'eventa:event:electron:discord:status-changed',
)

/** Raw event log entries for the Developer Console. */
export const discordServiceEventLog = defineEventa<DiscordEventLogEntry>(
  'eventa:event:electron:discord:event-log',
)

/** A Discord user sent a message that should be routed to the chat pipeline. */
export const discordServiceInboundMessage = defineEventa<DiscordInboundMessage>(
  'eventa:event:electron:discord:inbound-message',
)

/** Emitted when a slash command interaction is triggered. */
export const discordServiceInteraction = defineEventa<DiscordInteractionPayload>(
  'eventa:event:electron:discord:interaction',
)

// ── Voice (Voice Channel Audio Pipeline) ───────────────────────────────────────

/** Configuration the renderer ships to the main process so it can transcribe inbound audio. */
export interface DiscordVoiceSttConfig {
  baseUrl: string
  apiKey?: string
  model: string
  /** Whisper-style language hint, e.g. `vi` for Vietnamese. Empty = auto-detect. */
  language?: string
  /**
   * Whisper `prompt` parameter — biases recognition toward the wording style of
   * this prompt, but does NOT lock recognition to a single language. Useful for
   * Vietnamese conversations that mix English technical terms.
   */
  prompt?: string
  /** `verbose_json`, `json`, or `text` — defaults to `text`. */
  responseFormat?: 'text' | 'json' | 'verbose_json'
}

/** Lifecycle state of the active voice connection (only one at a time per AGENTS scope). */
export interface DiscordVoiceState {
  /** True when a `joinVoiceChannel` Ready handshake has completed. */
  connected: boolean
  /** True while we are currently piping TTS audio out to the channel. */
  speaking: boolean
  guildId: string | null
  channelId: string | null
  /** Display name of the voice channel (best effort, may be null pre-fetch). */
  channelName: string | null
  /** Lower-cased reason when `connected` flips to `false`. */
  lastError: string | null
  /** UserIDs currently transmitting audio (echoes Discord's speaking events). */
  activeSpeakers: string[]
}

/** Per-utterance transcript pushed from main → renderer after STT completes. */
export interface DiscordVoiceTranscript {
  guildId: string
  channelId: string
  userId: string
  username: string
  displayName: string
  text: string
  /** Wall-clock when the user stopped speaking (silence threshold trip). */
  endedAt: number
  /** Whisper/speaches sometimes emits a confidence proxy in verbose_json. */
  confidence?: number
}

export interface DiscordVoiceJoinByInteractionPayload {
  interactionId: string
  stt: DiscordVoiceSttConfig
}

export interface DiscordVoiceLeaveByInteractionPayload {
  interactionId: string
}

export interface DiscordVoiceJoinResult {
  ok: boolean
  error?: string
  state: DiscordVoiceState
}

/** Join the voice channel of the user who triggered a slash command. */
export const discordVoiceJoinByInteraction = defineInvokeEventa<DiscordVoiceJoinResult, DiscordVoiceJoinByInteractionPayload>(
  'eventa:invoke:electron:discord:voice:join-by-interaction',
)

/** Leave the active voice channel (interaction-aware: replies to the deferred command). */
export const discordVoiceLeaveByInteraction = defineInvokeEventa<DiscordVoiceJoinResult, DiscordVoiceLeaveByInteractionPayload>(
  'eventa:invoke:electron:discord:voice:leave-by-interaction',
)

/** Force-leave any active voice channel without an interaction (e.g. settings toggle). */
export const discordVoiceLeave = defineInvokeEventa<DiscordVoiceState>(
  'eventa:invoke:electron:discord:voice:leave',
)

/** Push the current STT/runtime config (renderer is the source of truth). */
export const discordVoiceUpdateSttConfig = defineInvokeEventa<void, { stt: DiscordVoiceSttConfig }>(
  'eventa:invoke:electron:discord:voice:update-stt-config',
)

/** Read current voice state on demand. */
export const discordVoiceGetState = defineInvokeEventa<DiscordVoiceState>(
  'eventa:invoke:electron:discord:voice:get-state',
)

/** Voice connection state changed (connected, speaking, channel, …). */
export const discordVoiceStateChanged = defineEventa<DiscordVoiceState>(
  'eventa:event:electron:discord:voice:state-changed',
)

/** A user finished an utterance and STT produced text. */
export const discordVoiceTranscriptCreated = defineEventa<DiscordVoiceTranscript>(
  'eventa:event:electron:discord:voice:transcript-created',
)
