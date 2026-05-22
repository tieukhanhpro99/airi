<script setup lang="ts">
import type { DuckDBWasmDrizzleDatabase } from '@proj-airi/drizzle-duckdb-wasm'
import type { Live2DLipSync, Live2DLipSyncOptions } from '@proj-airi/model-driver-lipsync'
import type { Profile } from '@proj-airi/model-driver-lipsync/shared/wlipsync'
import type { SpeechProviderWithExtraOptions } from '@xsai-ext/providers/utils'
import type { UnElevenLabsOptions } from 'unspeech'

import type { EmotionPayload } from '../../constants/emotions'

import { drizzle } from '@proj-airi/drizzle-duckdb-wasm'
import { getImportUrlBundles } from '@proj-airi/drizzle-duckdb-wasm/bundles/import-url-browser'
import { useElectronWindowResizeStateEvent } from '@proj-airi/electron-vueuse'
import { createLive2DLipSync } from '@proj-airi/model-driver-lipsync'
import { wlipsyncProfile } from '@proj-airi/model-driver-lipsync/shared/wlipsync'
import { createPlaybackManager, createSpeechPipeline, createTtsSegmentStream } from '@proj-airi/pipelines-audio'
import { Live2DScene, useLive2d } from '@proj-airi/stage-ui-live2d'
import { MMDScene, useMmd } from '@proj-airi/stage-ui-mmd'
import { SpineScene } from '@proj-airi/stage-ui-spine'
import { ThreeScene, useCustomVrmAnimationsStore, useModelStore } from '@proj-airi/stage-ui-three'
import { animations } from '@proj-airi/stage-ui-three/assets/vrm'
import { createQueue } from '@proj-airi/stream-kit'
import { useBroadcastChannel, useEventListener } from '@vueuse/core'
import { generateSpeech } from '@xsai/generate-speech'
import { storeToRefs } from 'pinia'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'

import { parseActor, useSpecialTokenQueue } from '../../composables/queues'
import { categorizeResponse } from '../../composables/response-categoriser'
import { llmInferenceEndToken } from '../../constants'
import { EMOTION_EmotionMotionName_value, EMOTION_VRMExpressionName_value, EmotionThinkMotionName } from '../../constants/emotions'
import { useAudioContext, useSpeakingStore } from '../../stores/audio'
import { useBackgroundStore } from '../../stores/background'
import { useChatOrchestratorStore } from '../../stores/chat'
import { useModsServerChannelStore } from '../../stores/mods/api/channel-server'
import { useAiriCardStore } from '../../stores/modules'
import { useAutonomousArtistryStore } from '../../stores/modules/artistry-autonomous'
import { useConsciousnessStore } from '../../stores/modules/consciousness'
import { useDiscordStore } from '../../stores/modules/discord'
import { useSpeechStore } from '../../stores/modules/speech'
import { useProvidersStore } from '../../stores/providers'
import { useSettings } from '../../stores/settings'
import { useSpeechRuntimeStore } from '../../stores/speech-runtime'
import { useVHackStore } from '../../stores/vhack'

withDefaults(defineProps<{
  paused?: boolean
  focusAt: { x: number, y: number }
  xOffset?: number | string
  yOffset?: number | string
  scale?: number
}>(), { paused: false, scale: 1 })

const emits = defineEmits<{
  (e: 'hitAreaHover', value: { name: string, x: number, y: number, hovered: boolean } | null): void
  (e: 'scaleChange', value: number): void
  (e: 'offsetChange', value: { x: number, y: number }): void
}>()

const componentState = defineModel<'pending' | 'loading' | 'mounted'>('state', { default: 'pending' })

const db = ref<DuckDBWasmDrizzleDatabase>()
// const transformersProvider = createTransformers({ embedWorkerURL })

const vrmViewerRef = ref<InstanceType<typeof ThreeScene>>()
const live2dSceneRef = ref<InstanceType<typeof Live2DScene>>()
const spineViewerRef = ref<InstanceType<typeof SpineScene>>()

const settingsStore = useSettings()
const vhackStore = useVHackStore()
const {
  stageModelRenderer,
  stageViewControlsEnabled,
  live2dDisableFocus,
  stageModelSelectedUrl,
  stageModelSelectedFile,
  stageModelSelected,
  themeColorsHue,
  themeColorsHueDynamic,
  live2dIdleAnimationEnabled,
  live2dAutoBlinkEnabled,
  live2dForceAutoBlinkEnabled,
  live2dShadowEnabled,
  live2dMaxFps,
  mmdTextureMap,
} = storeToRefs(settingsStore)
const { mouthOpenSize } = storeToRefs(useSpeakingStore())
const { audioContext } = useAudioContext()
const currentAudioSource = ref<AudioBufferSourceNode>()

const { onBeforeMessageComposed, onBeforeSend, onTokenLiteral, onTokenSpecial, onStreamEnd, onAssistantResponseEnd } = useChatOrchestratorStore()
const chatHookCleanups: Array<() => void> = []
// WORKAROUND: clear previous handlers on unmount to avoid duplicate calls when this component remounts.
//             We keep per-hook disposers instead of wiping the global chat hooks to play nicely with
//             cross-window broadcast wiring.

const providersStore = useProvidersStore()
const consciousnessStore = useConsciousnessStore()
const live2dStore = useLive2d()
const vrmStore = useModelStore()
const customVrmAnimationsStore = useCustomVrmAnimationsStore()
const viewUpdateCleanups: Array<() => void> = []

// Caption + Presentation broadcast channels
interface CaptionSegment { text: string, color: string, actorId: string, isActive?: boolean }
type CaptionChannelEvent
  = | { type: 'caption-speaker', text: string }
    | { type: 'caption-assistant', segments: CaptionSegment[] }
// NOTICE: do NOT add 'caption-speaker' or user speech to captions. This is intentionally AI-only.
const { post: postCaption } = useBroadcastChannel<CaptionChannelEvent, CaptionChannelEvent>({ name: 'airi-caption-overlay' })

// NOTICE: Secondary broadcast channel to listen for turn-resets (user messages)
// This is a hardware-level fix because the 'airi-caption-overlay' empty string reset was failing.
const { data: sessionUpdate } = useBroadcastChannel<any, any>({ name: 'airi-chat-stream' })

const actorColors = new Map<string, string>()
const parserActorId = ref<string>('default')
const playbackActorId = ref<string>('default')

function getActorColor(id: string): string {
  if (!actorColors.has(id)) {
    // Generate a stable, vibrant HSL color from the actor ID
    let hash = 0
    for (let i = 0; i < id.length; i++) {
      hash = id.charCodeAt(i) + ((hash << 5) - hash)
    }

    const h = Math.abs(hash) % 360
    // We lock saturation and lightness into high ranges (90-100% sat, 70-80% light)
    // This ensures the text is always bright, punchy, and readable against dark backgrounds.
    const s = 90 + (Math.abs(hash >> 8) % 10)
    const l = 70 + (Math.abs(hash >> 16) % 10)

    const color = `hsl(${h}, ${s}%, ${l}%)`
    actorColors.set(id, color)
    console.info(`[CaptionDebug] Assigned vibrant stable color to actor "${id}":`, color)
  }
  return actorColors.get(id)!
}

const assistantCaptionSegments = ref<CaptionSegment[]>([])

type PresentEvent
  = | { type: 'assistant-reset' }
    | { type: 'assistant-append', text: string }
const { post: postPresent } = useBroadcastChannel<PresentEvent, PresentEvent>({ name: 'airi-chat-present' })

viewUpdateCleanups.push(live2dStore.onShouldUpdateView((reason) => {
  // Live2D models already handle their own reload path inside the scene package.
  // We just sync the reason to the stage-model store for UI observability.
  if (reason)
    settingsStore.lastReloadReason = reason
}))

viewUpdateCleanups.push(vrmStore.onShouldUpdateView((reason) => {
  // VRM reloads are driven by modelSrc changes after updateStageModel().
  void settingsStore.updateStageModel(reason || 'vrm store update')
}))

const audioAnalyser = ref<AnalyserNode>()
const nowSpeaking = ref(false)
const lipSyncStarted = ref(false)
const lipSyncLoopId = ref<number>()
const live2dLipSync = ref<Live2DLipSync>()
const live2dLipSyncOptions: Live2DLipSyncOptions = { mouthUpdateIntervalMs: 50, mouthLerpWindowMs: 50 }

const { activeCard } = storeToRefs(useAiriCardStore())
const speechStore = useSpeechStore()
const { ssmlEnabled, activeSpeechProvider, activeSpeechModel, activeSpeechVoice, pitch } = storeToRefs(speechStore)
const { activeProvider: activeChatProvider } = storeToRefs(consciousnessStore)
const activeCardId = computed(() => activeCard.value?.name ?? 'default')
const speechRuntimeStore = useSpeechRuntimeStore()
const backgroundStore = useBackgroundStore()

const { activeBackgroundUrl } = storeToRefs(backgroundStore)
const discordStore = useDiscordStore()
const artistryAutonomousStore = useAutonomousArtistryStore()
const resizeStateEventName = useElectronWindowResizeStateEvent()
const isWindowResizing = ref(false)
const reducedRenderScale = computed(() => {
  const nextScale = Math.min(vrmStore.renderScale, 0.75)
  return Math.max(0.5, nextScale)
})
function handleResizeStateChange(event: Event) {
  const customEvent = event as CustomEvent<{ active?: boolean }>
  isWindowResizing.value = !!customEvent.detail?.active
}

useEventListener(typeof window !== 'undefined' ? window : null, 'vrm-node-visibility-toggle', (e: Event) => {
  const customEvent = e as CustomEvent<{ uuid: string, node: any }>
  vhackStore.toggleNodeVisibility(customEvent.detail.uuid, customEvent.detail.node)
})

const { currentMotion } = storeToRefs(live2dStore)

const temporaryVrma = ref<string | null>(null)
let temporaryVrmaTimeout: ReturnType<typeof setTimeout> | null = null

// Scheduler logic for seamless idle transitions
let schedulerTimer: ReturnType<typeof setTimeout> | null = null
let watchdogTimer: ReturnType<typeof setTimeout> | null = null

function clearAnimationTimers() {
  if (schedulerTimer) {
    clearTimeout(schedulerTimer)
    schedulerTimer = null
  }
  if (watchdogTimer) {
    clearTimeout(watchdogTimer)
    watchdogTimer = null
  }
}

function handleAnimationPlayStatus(status: { duration: number, url: string }) {
  clearAnimationTimers()

  // Schedule next animation 0.8s before this one ends (cross-fade window)
  const delay = Math.max(0, (status.duration - 0.8) * 1000)
  schedulerTimer = setTimeout(() => {
    handleAnimationFinished()
  }, delay)

  // Safety watchdog: force a cycle if we get stuck for > 20s
  watchdogTimer = setTimeout(() => {
    console.warn('[Stage] Animation watchdog triggered (20s stall detected)')
    handleAnimationFinished()
  }, 20000)
}

const vrmActiveAnimation = computed(() => {
  const cardIdleAnimations = activeCard.value?.extensions?.airi?.acting?.idleAnimations || []
  let baseKey = vrmStore.vrmIdleAnimation

  // Tier 1: Character (if exactly 1 selected, we stick to it)
  if (cardIdleAnimations.length === 1) {
    baseKey = cardIdleAnimations[0]
  }
  // Tier 2: Global Fallback / Subsection clamping
  else if (cardIdleAnimations.length > 1 && !cardIdleAnimations.includes(baseKey)) {
    const validKeys = cardIdleAnimations.filter(k => customVrmAnimationsStore.animationKeys.includes(k))
    if (validKeys.length > 0) {
      baseKey = validKeys[0]
    }
  }

  const vrmaKey = temporaryVrma.value || baseKey
  return customVrmAnimationsStore.resolveAnimationUrl(vrmaKey)
})

watch(() => activeCard.value?.extensions?.airi?.acting?.idleAnimations, (cardIdleAnimations) => {
  if (cardIdleAnimations && cardIdleAnimations.length > 1 && !cardIdleAnimations.includes(vrmStore.vrmIdleAnimation)) {
    const validKeys = cardIdleAnimations.filter(k => customVrmAnimationsStore.animationKeys.includes(k))
    if (validKeys.length > 0 && vrmStore.vrmIdleCycleEnabled) {
      vrmStore.vrmIdleAnimation = validKeys[0]
    }
  }
}, { immediate: true })

const vrmEffectiveIdleCycleEnabled = computed(() => {
  const cardIdleAnimations = activeCard.value?.extensions?.airi?.acting?.idleAnimations || []
  if (cardIdleAnimations.length > 1)
    return true
  if (cardIdleAnimations.length === 1)
    return false
  return vrmStore.vrmIdleCycleEnabled
})

const emotionsQueue = createQueue<EmotionPayload>({
  handlers: [
    async (ctx) => {
      if (stageModelRenderer.value === 'vrm') {
        const emotionName = ctx.data.name
        const isVrma = emotionName in animations

        if (isVrma) {
          temporaryVrma.value = emotionName
        }

        const value = (EMOTION_VRMExpressionName_value as any)[emotionName] ?? emotionName

        if (!value)
          return

        if (vrmViewerRef.value) {
          // Only trigger expression if it's a known mapping or a valid raw expression.
          // This prevents warnings and interference for motion-only tokens.
          const isExpression = emotionName in EMOTION_VRMExpressionName_value || vrmViewerRef.value.listExpressions().includes(value)

          if (isExpression) {
            vrmViewerRef.value.setExpression(value, ctx.data.intensity, 2000)
          }
        }
        else {
          console.warn('[Stage] vrmViewerRef is NULL')
        }
      }
      else if (stageModelRenderer.value === 'live2d') {
        const emotionName = ctx.data.name
        const intensity = ctx.data.intensity
        console.info('[Stage] Live2D emotion processing:', { name: emotionName, intensity })

        // Delegate to store (handles mappings, name-matched fallbacks, and robust resets)
        const triggered = live2dStore.triggerEmotion(emotionName, intensity)
        if (!triggered) {
          // Final fallback: try motion mapping
          const motionGroup = (EMOTION_EmotionMotionName_value as any)[emotionName]
          if (motionGroup) {
            currentMotion.value = { group: motionGroup }
          }
          else {
            // New fallback: try to find motion by name in availableMotions (Ground Truth)
            const motionMappings = (activeCard.value as any)?.extensions?.airi?.modules?.live2d?.motionMappings || {}
            const matchedMotion = live2dStore.availableMotions.find((m: any) => {
              const name = m.fileName.split('/').pop() || m.fileName
              const cleanName = name.replace('.motion3.json', '').replace('.json', '')
              const mappedName = motionMappings[m.fileName]
              return name === emotionName || m.fileName === emotionName || cleanName === emotionName || mappedName === emotionName
            })
            if (matchedMotion) {
              currentMotion.value = { group: matchedMotion.motionName, index: matchedMotion.motionIndex }
              console.info('[Stage] Triggered Live2D motion from dropdown name:', emotionName)
            }
            else {
              console.warn('[Stage] No Live2D explicit mapping, name match, or motion found for:', emotionName)
            }
          }
        }
      }
      else if (stageModelRenderer.value === 'spine') {
        const emotionName = ctx.data.name
        const intensity = ctx.data.intensity
        console.info('[Stage] Spine emotion/motion processing:', { name: emotionName, intensity })
        if (spineViewerRef.value) {
          spineViewerRef.value.setEmotion(emotionName as any, intensity)
        }
        else {
          console.warn('[Stage] spineViewerRef is NULL')
        }
      }
      else if (stageModelRenderer.value === 'mmd') {
        const emotionName = ctx.data.name
        const intensity = ctx.data.intensity
        console.info('[Stage] MMD emotion/motion processing:', { name: emotionName, intensity })

        const mmdStore = useMmd()

        // 1. Check if it's a motion (fuzzy match without .vmd)
        const matchedMotion = mmdStore.availableMotions.find((m) => {
          const cleanName = m.replace('.vmd', '')
          return m === emotionName || cleanName === emotionName
        })

        if (matchedMotion) {
          mmdStore.currentMotion = matchedMotion
          console.info('[Stage] Triggered MMD motion:', matchedMotion)
        }
        else {
          // 2. It's an expression (morph)
          // The LLM might emit the MAPPED name. We need to find the RAW name!
          const mappings = mmdStore.morphMappings || {}
          let rawMorphName = emotionName

          // Reverse lookup in mappings (raw -> mapped)
          for (const [raw, mapped] of Object.entries(mappings)) {
            if (mapped === emotionName) {
              rawMorphName = raw
              break
            }
          }

          mmdStore.previewExpression = rawMorphName
          console.info('[Stage] Triggered MMD expression:', rawMorphName)
        }
      }
    },
  ],
})

const specialTokenQueue = useSpecialTokenQueue(emotionsQueue)
specialTokenQueue.onHandlerEvent('emotion', (emotion) => {
  console.info('[Stage] Emotion token detected:', emotion)
})
specialTokenQueue.onHandlerEvent('delay', (delay) => {
  console.info('[Stage] Delay token detected:', delay)
})
specialTokenQueue.onHandlerEvent('actor', (actorId) => {
  console.info('[Stage] Actor swap token detected (parser):', actorId)
  parserActorId.value = actorId
  void artistryAutonomousStore.activateConcept(actorId)
})

// Play special token: delay or emotion
function playSpecialToken(special: string) {
  console.info('[Stage] Enqueueing special token:', special)
  specialTokenQueue.enqueue(special)
}

const modsServer = useModsServerChannelStore()

function processMarkers(content: string) {
  const markers = content.match(/<\|(?:ACT|DELAY|ACTOR)[^\r\n]*?(?:\|>|>)/gi)
  if (markers) {
    console.info('[Stage] Markers detected:', markers)
    for (const marker of markers) {
      playSpecialToken(marker)
    }
  }
}

// NOTICE: These modsServer listeners exist ONLY for external plugin/mod messages
// that bypass the normal chat orchestrator pipeline. Messages originating from
// the local chatOrchestrator are ALREADY processed token-by-token via the
// speechPipeline's onTokenSpecial hook. Blindly re-processing them here caused
// every ACT/DELAY/ACTOR token to execute TWICE — once during streaming and again
// when the full message was broadcast via the context bridge. The
// `stage-tamagotchi` and `stage-web` flags let us identify and skip local messages.
const modsServerCleanups: Array<() => void> = []

modsServerCleanups.push(modsServer.onEvent('output:gen-ai:chat:message', (event) => {
  // Skip messages that originated from this app's own chat pipeline
  if (event.data?.['stage-tamagotchi'] || event.data?.['stage-web']) {
    return
  }

  console.info('[Stage] Received external message:', event.data)
  if (typeof event.data?.message?.content === 'string') {
    processMarkers(event.data.message.content)
  }
}))

modsServerCleanups.push(modsServer.onEvent('input:text', (event) => {
  // Skip messages that originated from this app's own input pipeline
  if (event.data?.['stage-tamagotchi'] || event.data?.['stage-web']) {
    return
  }

  console.info('[Stage] Received external input:', event.data)
  if (event.data?.text) {
    processMarkers(event.data.text)
  }
}))

let currentChatIntent: ReturnType<typeof speechRuntimeStore.openIntent> | null = null
const currentChatIntentReceivedLiteral = ref(false)

const lipSyncNode = ref<AudioNode>()

if (typeof window !== 'undefined') {
  (window as any).testEmotion = (emotion: string) => {
    console.info('[DEBUG] Manually triggering emotion:', emotion)
    processMarkers(`<|ACT:{"emotion":"${emotion}"}|>`)
  }

  (window as any).listExpressions = () => {
    const expressions = vrmViewerRef.value?.listExpressions?.()
    console.info('[DEBUG] Available Expressions:', expressions)
    return expressions
  }

  (window as any).setRawExpression = (name: string, value: number) => {
    console.info('[DEBUG] Setting raw expression (3s reset):', name, value)
    vrmViewerRef.value?.setExpression(name, value, 3000)
  }

  (window as any).setPersistentExpression = (name: string, value: number) => {
    console.info('[DEBUG] Setting persistent expression (NO reset):', name, value)
    vrmViewerRef.value?.setExpression(name, value)
  }

  (window as any).stopAnimations = () => {
    console.info('[DEBUG] Stopping all animations')
    vrmViewerRef.value?.stopAnimations()
  }

  (window as any).testMarker = (content: string) => {
    console.info('[DEBUG] Manually testing marker:', content)
    playSpecialToken(content)
  }

  ;(window as any).simulateAssistant = (content: string) => {
    console.info('[DEBUG] Simulating assistant response:', content)

    const intent = ensureSpeechIntent()

    // Split content into markers and text segments
    const parts = content.split(/(<\|(?:ACT|DELAY|ACTOR)[^\r\n]*?(?:\|>|>))/gi)
    for (const part of parts) {
      if (!part)
        continue
      if (part.startsWith('<|')) {
        intent.writeSpecial(part)
      }
      else {
        intent.writeLiteral(part)
      }
    }
    intent.writeFlush()
    intent.end()
    currentChatIntent = null
  }
}

async function playFunction(item: Parameters<Parameters<typeof createPlaybackManager<AudioBuffer>>[0]['play']>[0], signal: AbortSignal): Promise<void> {
  if (!audioContext || !item.audio)
    return

  // Ensure audio context is resumed (browsers suspend it by default until user interaction)
  if (audioContext.state === 'suspended') {
    try {
      await audioContext.resume()
    }
    catch {
      return
    }
  }

  const source = audioContext.createBufferSource()
  currentAudioSource.value = source
  source.buffer = item.audio

  // Mute local speaker output while AIRI is in a Discord voice channel and the
  // user has opted in to "mute local TTS while in voice". The bot still emits
  // audio via the main-process AudioPlayer, and we keep the analyser/lip-sync
  // connections so the VRM/Live2D mouth tracks the bot's voice.
  const muteLocalForVoice = !!(discordStore.voiceMuteLocalTts && discordStore.isVoiceConnected)

  // Ensure connections are robust
  if (!muteLocalForVoice)
    source.connect(audioContext.destination)
  if (audioAnalyser.value)
    source.connect(audioAnalyser.value)

  // Explicitly ensure lip-sync setup is called if not already started
  if (!lipSyncStarted.value) {
    await setupLipSync()
  }

  if (lipSyncNode.value)
    source.connect(lipSyncNode.value)

  return new Promise<void>((resolve) => {
    let settled = false
    const resolveOnce = () => {
      if (settled)
        return
      settled = true
      resolve()
    }

    const stopPlayback = () => {
      try {
        source.stop()
        source.disconnect()
      }
      catch {}
      if (currentAudioSource.value === source)
        currentAudioSource.value = undefined
      resolveOnce()
    }

    if (signal.aborted) {
      stopPlayback()
      return
    }

    signal.addEventListener('abort', stopPlayback, { once: true })
    source.onended = () => {
      signal.removeEventListener('abort', stopPlayback)
      stopPlayback()
    }

    try {
      source.start(0)
    }
    catch {
      stopPlayback()
    }
  })
}

const playbackManager = createPlaybackManager<AudioBuffer>({
  play: playFunction,
  maxVoices: 1,
  maxVoicesPerOwner: 1,
  overflowPolicy: 'queue',
  ownerOverflowPolicy: 'steal-oldest',
})

// Keep self-hosted TTS smooth by avoiding one request per short sentence.
// Longer segments let the next generation finish while the current audio plays.
const smoothTtsSegmenter = ((tokens, meta) => createTtsSegmentStream(tokens, meta, {
  boost: 0,
  minimumWords: 10,
  maximumWords: 34,
  hardPunctuationMinWords: 16,
})) satisfies Parameters<typeof createSpeechPipeline<AudioBuffer>>[0]['segmenter']

const speechPipeline = createSpeechPipeline<AudioBuffer>({
  segmenter: smoothTtsSegmenter,
  tts: async (request, signal) => {
    if (import.meta.env.DEV)
      console.info('[Stage:TTS] Request received:', { text: request.text?.slice(0, 30), special: request.special })

    if (signal.aborted) {
      console.warn('[Stage:TTS] Request aborted early')
      return null
    }

    if (request.special) {
      const actorId = parseActor(request.special)
      if (actorId) {
        // NOTICE: Only preload the VOICE here (generation-time) so the next audio
        // segment uses the correct TTS provider/model/voice. The full concept
        // activation (model swap, background swap, concept stack update) is deferred
        // to playback-time via the playback manager's onEnd → specialTokenQueue path.
        console.info('[Stage:TTS] Actor swap detected — preloading voice only (model deferred to playback)', actorId)
        artistryAutonomousStore.preloadConceptVoice(actorId)
        return null
      }
    }

    if (activeSpeechProvider.value === 'speech-noop')
      return null

    if (!activeSpeechProvider.value)
      return null

    const provider = await providersStore.getProviderInstance(activeSpeechProvider.value) as SpeechProviderWithExtraOptions<string, UnElevenLabsOptions>
    if (!provider) {
      console.error('Failed to initialize speech provider')
      return null
    }

    if (!request.text && !request.special)
      return null

    const providerConfig = providersStore.getProviderConfig(activeSpeechProvider.value)

    // For OpenAI Compatible providers, always use provider config for model and voice
    // since these are manually configured in provider settings
    let model = activeSpeechModel.value
    let voice = activeSpeechVoice.value

    if (activeSpeechProvider.value === 'openai-compatible-audio-speech') {
      // Prioritize global selections, then provider settings, then defaults
      model = model || providerConfig?.model as string || 'tts-1'

      if (!voice) {
        if (providerConfig?.voice) {
          voice = {
            id: providerConfig.voice as string,
            name: providerConfig.voice as string,
            description: providerConfig.voice as string,
            previewURL: '',
            languages: [{ code: 'en', title: 'English' }],
            provider: activeSpeechProvider.value,
            gender: 'neutral',
          }
        }
        else {
          voice = {
            id: 'alloy',
            name: 'alloy',
            description: 'alloy',
            previewURL: '',
            languages: [{ code: 'en', title: 'English' }],
            provider: activeSpeechProvider.value,
            gender: 'neutral',
          }
        }
      }

      console.info('[Speech Pipeline] Resolved OpenAI Compatible Stats', { model, voice: voice?.id })
    }

    if (!model || !voice)
      return null

    const transformedText = speechStore.transformTextForSpeech(request.text, activeSpeechProvider.value)

    if (!transformedText.trim() && !request.special)
      return null

    const input = ssmlEnabled.value
      ? speechStore.generateSSML(transformedText, voice, { ...providerConfig, pitch: pitch.value })
      : transformedText

    try {
      const res = await generateSpeech({
        ...provider.speech(model, providerConfig),
        input,
        voice: voice.id,
      })

      if (signal.aborted || !res || res.byteLength === 0)
        return null

      // Tap into the audio stream for Discord Voice Notes
      // We slice() because decodeAudioData(res) will detach the original buffer.
      discordStore.addAudioToTurn(res.slice(0))

      const audioBuffer = await audioContext.decodeAudioData(res)
      return audioBuffer
    }
    catch {
      return null
    }
  },
  playback: playbackManager,
})

speechPipeline.on('onIntentEnd', () => {
  void discordStore.flushAudioTurn()
})

speechPipeline.on('onIntentCancel', () => {
  discordStore.clearAudioTurn()
})

// NOTICE: the speech runtime host must follow the Stage lifecycle. If a previous Stage instance
// keeps the host registration after unmount, chat text can continue rendering while TTS writes
// into a stale pipeline owned by the dead component.
void speechRuntimeStore.registerHost(speechPipeline)

speechPipeline.on('onSpecial', (segment) => {
  if (segment.special)
    playSpecialToken(segment.special)
})

playbackManager.onEnd(({ item }) => {
  try {
    if (item.special) {
      const actorId = parseActor(item.special)
      if (actorId) {
        console.info('[Stage] Actor swap token reached playback:', actorId)
        playbackActorId.value = actorId
      }
      playSpecialToken(item.special)
    }

    // Deactivate segment when playback ends
    if (item.text?.trim()) {
      const segment = assistantCaptionSegments.value.find(s => s.text === item.text && s.isActive)
      if (segment) {
        segment.isActive = false
        postCaption({
          type: 'caption-assistant',
          segments: JSON.parse(JSON.stringify(assistantCaptionSegments.value)),
        })
      }
    }
  }
  catch (error) {
    console.error('[Stage] Error in playbackManager.onEnd:', error)
  }

  nowSpeaking.value = false
  mouthOpenSize.value = 0
})

playbackManager.onStart(({ item }) => {
  nowSpeaking.value = true

  try {
    // Update caption segments when a new audio segment starts
    if (item.text?.trim()) {
      const actorId = playbackActorId.value
      const color = getActorColor(actorId)

      // Deactivate any currently active segments
      assistantCaptionSegments.value.forEach(s => s.isActive = false)

      assistantCaptionSegments.value.push({
        text: item.text,
        color,
        actorId,
        isActive: true,
      })

      try {
        // Use toRaw to ensure the Proxy doesn't interfere with BroadcastChannel cloning
        postCaption({
          type: 'caption-assistant',
          segments: JSON.parse(JSON.stringify(assistantCaptionSegments.value)),
        })
      }
      catch (error) {
        console.warn('[Stage] Failed to broadcast caption update:', error)
      }
    }
  }
  catch (error) {
    console.error('[Stage] Error in playbackManager.onStart:', error)
  }

  try {
    postPresent({ type: 'assistant-append', text: item.text })
  }
  catch {
    // ignore
  }
})

function startLipSyncLoop() {
  if (lipSyncLoopId.value)
    return

  const tick = () => {
    if (!nowSpeaking.value || !live2dLipSync.value) {
      mouthOpenSize.value = 0
    }
    else {
      mouthOpenSize.value = live2dLipSync.value.getMouthOpen()
    }
    lipSyncLoopId.value = requestAnimationFrame(tick)
  }

  lipSyncLoopId.value = requestAnimationFrame(tick)
}

async function setupLipSync() {
  if (lipSyncStarted.value)
    return

  if (!audioContext || !audioContext.audioWorklet) {
    console.warn('[Stage] Lip sync skipped: AudioWorklet is not available in this browser context (requires HTTPS or localhost).')
    return
  }

  try {
    const lipSync = await createLive2DLipSync(audioContext, wlipsyncProfile as Profile, live2dLipSyncOptions)
    live2dLipSync.value = lipSync
    lipSyncNode.value = lipSync.node
    await audioContext.resume()
    startLipSyncLoop()
    lipSyncStarted.value = true
  }
  catch (error) {
    lipSyncStarted.value = false
    console.error('Failed to setup Live2D lip sync', error)
  }
}

function setupAnalyser() {
  if (!audioAnalyser.value) {
    audioAnalyser.value = audioContext.createAnalyser()
  }
}

function ensureSpeechIntent(behavior: 'interrupt' | 'queue' = 'interrupt') {
  if (currentChatIntent)
    return currentChatIntent

  console.info('[Stage] Opening speech intent', { ownerId: activeCardId.value, behavior })
  currentChatIntent = speechRuntimeStore.openIntent({
    ownerId: activeCardId.value,
    priority: 'normal',
    behavior,
  })
  console.info('[Stage] Speech intent opened', { intentId: currentChatIntent.intentId, streamId: currentChatIntent.streamId })

  return currentChatIntent
}

// Hardware-level turn reset: clear everything when a new user message enters the session
// This is the absolute truth for turn boundaries and prevents 'blob' accumulation.
chatHookCleanups.push(watch(sessionUpdate, (event) => {
  if (event?.type === 'session-updated' && event.message?.role === 'user') {
    console.info('[Stage] New user turn detected (via session-updated), resetting caption accumulator.')
    assistantCaptionSegments.value = []
    parserActorId.value = activeCardId.value
    playbackActorId.value = activeCardId.value
    try {
      postCaption({ type: 'caption-assistant', segments: [] })
    }
    catch {}
  }
}))

chatHookCleanups.push(onBeforeMessageComposed(async () => {
  // NOTICE: chat and proactivity share the same speech lane. Stopping playback alone is not
  // enough if a previous turn left an active or queued intent inside the speech pipeline.
  // Reset the entire host pipeline on each new assistant turn so later chat TTS cannot inherit
  // stale proactivity/chat intent state.
  speechPipeline.stopAll('new-message')
  discordStore.clearAudioTurn()

  setupAnalyser()
  await setupLipSync()
  // Reset assistant caption and actor tracking for a new message
  assistantCaptionSegments.value = []
  parserActorId.value = activeCardId.value
  playbackActorId.value = activeCardId.value
  try {
    postCaption({ type: 'caption-assistant', segments: [] })
  }
  catch (error) {
    // BroadcastChannel may be closed if user navigated away - don't break flow
    console.warn('[Stage] Failed to post caption reset (channel may be closed)', { error })
  }
  try {
    postPresent({ type: 'assistant-reset' })
  }
  catch (error) {
    // BroadcastChannel may be closed if user navigated away - don't break flow
    console.warn('[Stage] Failed to post present reset (channel may be closed)', { error })
  }

  if (currentChatIntent) {
    console.info('[Stage] Cancelling existing speech intent for new message', { intentId: currentChatIntent.intentId })
    currentChatIntent.cancel('new-message')
    currentChatIntent = null
  }

  currentChatIntentReceivedLiteral.value = false
  ensureSpeechIntent()
}))

chatHookCleanups.push(onBeforeSend(async () => {
  currentMotion.value = { group: EmotionThinkMotionName }
}))

chatHookCleanups.push(onTokenLiteral(async (literal) => {
  // const orchestrator = useChatOrchestratorStore()
  const intent = ensureSpeechIntent()
  if (import.meta.env.DEV) {
    console.info('[PipelineTTS:Stage] onTokenLiteral triggered:', {
      hash: window.location.hash,
      hasIntent: !!intent,
      intentId: intent?.intentId,
      literalPreview: literal.slice(0, 10),
    })
  }

  if (!intent)
    return
  currentChatIntentReceivedLiteral.value = true
  console.info('[PipelineTTS:Stage] onTokenLiteral -> forwarding to speech', {
    intentId: intent.intentId,
    length: literal.length,
    preview: literal.slice(0, 120),
  })
  intent.writeLiteral(literal)
}))

chatHookCleanups.push(onTokenSpecial(async (special) => {
  const intent = ensureSpeechIntent()
  if (!intent)
    return
  // console.info('Stage received special token:', special)
  console.info('[Stage] onTokenSpecial -> forwarding', { intentId: intent.intentId, special })
  intent.writeSpecial(special)
}))

chatHookCleanups.push(onStreamEnd(async () => {
  specialTokenQueue.enqueue(llmInferenceEndToken)
  const intent = ensureSpeechIntent()
  if (intent)
    console.info('[Stage] onStreamEnd -> flush intent', { intentId: intent.intentId })
  intent?.writeFlush()
}))

chatHookCleanups.push(onAssistantResponseEnd(async (message) => {
  if (!currentChatIntentReceivedLiteral.value) {
    const fallbackSpeech = categorizeResponse(message, activeChatProvider.value).speech.trim()
    if (fallbackSpeech) {
      const intent = ensureSpeechIntent()
      console.info('[Stage] onAssistantResponseEnd -> fallback speech literal', {
        intentId: intent.intentId,
        length: fallbackSpeech.length,
      })
      intent.writeLiteral(fallbackSpeech)
      intent.writeFlush()
    }
  }

  if (currentChatIntent)
    console.info('[Stage] onAssistantResponseEnd -> ending intent', { intentId: currentChatIntent.intentId })
  currentChatIntent?.end()
  currentChatIntent = null
  currentChatIntentReceivedLiteral.value = false

  // Restore VRM expressions and animations to user-configured defaults after speech ends
  if (stageModelRenderer.value === 'vrm') {
    vrmViewerRef.value?.restoreDefaultExpressions()

    // Reset to idle animation when the entire turn ends
    if (temporaryVrmaTimeout) {
      clearTimeout(temporaryVrmaTimeout)
      temporaryVrmaTimeout = null
    }
    temporaryVrma.value = null
  }
  // const res = await embed({
  //   ...transformersProvider.embed('Xenova/nomic-embed-text-v1'),
  //   input: message,
  // })

  // await db.value?.execute(`INSERT INTO memory_test (vec) VALUES (${JSON.stringify(res.embedding)});`)
}))

function handleAnimationFinished() {
  if (stageModelRenderer.value !== 'vrm')
    return

  // Clear timers to prevent race conditions
  clearAnimationTimers()

  // Resume idle from ACT performance
  if (temporaryVrma.value) {
    temporaryVrma.value = null
  }

  // Cycle logic (Tier 1: Card Subset | Tier 2: Global)
  const cardIdleAnimations = activeCard.value?.extensions?.airi?.acting?.idleAnimations || []
  const hasCardSubset = cardIdleAnimations.length > 0
  if (vrmEffectiveIdleCycleEnabled.value) {
    const keys = hasCardSubset ? cardIdleAnimations : customVrmAnimationsStore.animationKeys

    // Fall back to the original full subset if none of the customized ones are currently valid
    const validKeys = keys.filter(k => customVrmAnimationsStore.animationKeys.includes(k))
    const finalKeys = validKeys.length > 0 ? validKeys : customVrmAnimationsStore.animationKeys

    const currentKey = vrmStore.vrmIdleAnimation
    const otherKeys = finalKeys.filter(key => key !== currentKey)

    // Selection
    if (finalKeys.length === 1) {
      vrmStore.vrmIdleAnimation = finalKeys[0]
    }
    else {
      const selection = otherKeys.length > 0 ? otherKeys : finalKeys
      const randomKey = selection[Math.floor(Math.random() * selection.length)]
      if (randomKey && vrmStore.vrmIdleAnimation !== randomKey) {
        vrmStore.vrmIdleAnimation = randomKey
      }
      else if (randomKey === vrmStore.vrmIdleAnimation && otherKeys.length > 0) {
        // Fallback safety if random picked the same one somehow
        vrmStore.vrmIdleAnimation = otherKeys[0]
      }
    }
  }
}

onUnmounted(() => {
  lipSyncStarted.value = false
  clearAnimationTimers()
})

// Resume audio context on first user interaction (browser requirement)
let audioContextResumed = false
function resumeAudioContextOnInteraction() {
  if (audioContextResumed || !audioContext)
    return
  audioContextResumed = true
  audioContext.resume().catch(() => {
    // Ignore errors - audio context will be resumed when needed
  })
}

// Add event listeners for user interaction
if (typeof window !== 'undefined') {
  const events = ['click', 'touchstart', 'keydown']
  events.forEach((event) => {
    window.addEventListener(event, resumeAudioContextOnInteraction, { once: true, passive: true })
  })
  window.addEventListener(resizeStateEventName, handleResizeStateChange as EventListener)
}

onMounted(async () => {
  db.value = drizzle({ connection: { bundles: getImportUrlBundles() } })
  await db.value.execute(`CREATE TABLE memory_test (vec FLOAT[768]);`)
})

function canvasElement() {
  if (stageModelRenderer.value === 'live2d')
    return live2dSceneRef.value?.canvasElement()

  else if (stageModelRenderer.value === 'vrm')
    return vrmViewerRef.value?.canvasElement()
}

function readRenderTargetRegionAtClientPoint(clientX: number, clientY: number, radius: number) {
  if (stageModelRenderer.value !== 'vrm')
    return null

  return vrmViewerRef.value?.readRenderTargetRegionAtClientPoint?.(clientX, clientY, radius) ?? null
}

async function captureFrame() {
  const charBlob = await (stageModelRenderer.value === 'live2d'
    ? live2dSceneRef.value?.captureFrame()
    : vrmViewerRef.value?.captureFrame())

  if (!activeBackgroundUrl.value || !charBlob)
    return charBlob

  try {
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (!ctx)
      return charBlob

    // Load background image
    const bgImg = new Image()
    bgImg.crossOrigin = 'anonymous'
    bgImg.src = activeBackgroundUrl.value
    await new Promise((resolve, reject) => {
      bgImg.onload = resolve
      bgImg.onerror = reject
    })

    // Load character frame
    const charImg = await createImageBitmap(charBlob)

    // Match canvas size to the captured frame (respects DPI/Render Scale)
    canvas.width = charImg.width
    canvas.height = charImg.height

    // Draw background with "cover" logic
    const scale = Math.max(canvas.width / bgImg.width, canvas.height / bgImg.height)
    const w = bgImg.width * scale
    const h = bgImg.height * scale
    const x = (canvas.width - w) / 2
    const y = (canvas.height - h) / 2

    ctx.drawImage(bgImg, x, y, w, h)

    // Draw character on top
    ctx.drawImage(charImg, 0, 0)

    return new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
  }
  catch (error) {
    console.error('[Stage] Failed to composite photo with background:', error)
    return charBlob // Fallback to character-only
  }
}

onUnmounted(() => {
  if (lipSyncLoopId.value) {
    cancelAnimationFrame(lipSyncLoopId.value)
    lipSyncLoopId.value = undefined
  }

  chatHookCleanups.forEach(dispose => dispose?.())
  viewUpdateCleanups.forEach(dispose => dispose?.())
  modsServerCleanups.forEach(dispose => dispose?.())
  void speechRuntimeStore.unregisterHost(speechPipeline)
  if (typeof window !== 'undefined') {
    window.removeEventListener(resizeStateEventName, handleResizeStateChange as EventListener)
  }
})

defineExpose({
  canvasElement,
  captureFrame,
  readRenderTargetRegionAtClientPoint,
})
</script>

<template>
  <div :class="['relative h-full w-full']">
    <!-- Scene Background Layer -->
    <div
      v-if="activeBackgroundUrl"
      :class="[
        'absolute left-0 top-0 z-0 h-full w-full',
        'transition-opacity duration-500',
      ]"
      :style="{
        backgroundImage: `url(${activeBackgroundUrl})`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        backgroundRepeat: 'no-repeat',
      }"
    />

    <div :class="['relative h-full w-full']">
      <Live2DScene
        v-if="stageModelRenderer === 'live2d'"
        ref="live2dSceneRef"
        v-model:state="componentState"
        :class="['min-w-50% <lg:full min-h-100 sm:100', 'h-full w-full flex-1']"
        :model-src="stageModelSelectedUrl"
        :model-id="stageModelSelected"
        :model-file="stageModelSelectedFile"
        :focus-at="focusAt"
        :mouth-open-size="mouthOpenSize"
        :paused="paused"
        :x-offset="xOffset"
        :y-offset="yOffset"
        :scale="scale"
        :disable-focus-at="live2dDisableFocus"
        :theme-colors-hue="themeColorsHue"
        :theme-colors-hue-dynamic="themeColorsHueDynamic"
        :live2d-idle-animation-enabled="live2dIdleAnimationEnabled"
        :live2d-auto-blink-enabled="live2dAutoBlinkEnabled"
        :live2d-force-auto-blink-enabled="live2dForceAutoBlinkEnabled"
        :live2d-shadow-enabled="live2dShadowEnabled"
        :live2d-max-fps="live2dMaxFps"
        :idle-animations="activeCard?.extensions?.airi?.acting?.idleAnimations"
        :draggable="stageViewControlsEnabled"
        @scale-change="(val) => emits('scaleChange', val)"
        @offset-change="(val) => emits('offsetChange', val)"
      />
      <ThreeScene
        v-if="stageModelRenderer === 'vrm'"
        ref="vrmViewerRef"
        v-model:state="componentState"
        :model-src="stageModelSelectedUrl"
        :model-identity="stageModelSelected"
        :idle-animation="vrmActiveAnimation"
        :idle-cycle-enabled="vrmEffectiveIdleCycleEnabled"
        :render-scale-override="isWindowResizing ? reducedRenderScale : undefined"
        :class="['min-w-50% <lg:full min-h-100 sm:100', 'h-full w-full flex-1']"
        :paused="paused"
        :show-axes="stageViewControlsEnabled"
        :current-audio-source="currentAudioSource"
        @error="console.error"
        @binary-loaded="vhackStore.setSourceArrayBuffer"
        @finished="handleAnimationFinished"
        @play-status="handleAnimationPlayStatus"
      />
      <SpineScene
        v-if="stageModelRenderer === 'spine'"
        ref="spineViewerRef"
        v-model:state="componentState"
        :model-src="stageModelSelectedUrl"
        :model-id="stageModelSelected"
        :class="['min-w-50% <lg:full min-h-100 sm:100', 'h-full w-full flex-1']"
        :paused="paused"
        :interaction-mode="vrmStore.interactionMode"
        :x-offset="xOffset !== undefined ? Number(xOffset) : undefined"
        :y-offset="yOffset !== undefined ? Number(yOffset) : undefined"
        :scale="scale !== undefined ? Number(scale) : undefined"
        @hit-area-hover="(val) => emits('hitAreaHover', val)"
      />
      <MMDScene
        v-if="stageModelRenderer === 'mmd' && stageModelSelectedUrl"
        v-model:state="componentState"
        :class="['min-w-50% <lg:full min-h-100 sm:100', 'h-full w-full flex-1']"
        :model-src="stageModelSelectedUrl"
        :paused="paused"
        :current-audio-source="currentAudioSource"
        :texture-map="mmdTextureMap"
        @error="console.error"
      />
    </div>
  </div>
</template>
