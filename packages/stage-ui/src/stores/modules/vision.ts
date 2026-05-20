import type { ScreenCaptureResult, VisionSource } from '@proj-airi/stage-shared'

import { useElectronEventaInvoke } from '@proj-airi/electron-vueuse'
import {
  isWithinSchedule,
  sensorsGetActiveWindow,
  visionCaptureScreen,
  visionCheckPermission,
  visionListSources,
  visionRequestPermission,
} from '@proj-airi/stage-shared'
import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { useIntervalFn } from '@vueuse/core'
import { defineStore, storeToRefs } from 'pinia'
import { computed, onUnmounted, ref, watch } from 'vue'
import { toast } from 'vue-sonner'

import { useChatOrchestratorStore } from '../chat'
import { useProvidersStore } from '../providers'
import { useAiriCardStore } from './airi-card'
import { useLiveSessionStore } from './live-session'

/**
 * Vision store: drives screen capture + multimodal LLM proactive observation.
 *
 * Three operating modes (independent toggles):
 *   - On-demand: hotkey or `/look` slash command triggers a single capture.
 *   - Periodic: background interval (`witnessIntervalMinutes`) triggers when bot is idle.
 *   - Smart: triggers when the user's active window changes (foreground app swap).
 *
 * Privacy gates (all checked before every capture):
 *   - `pausedUntil` timestamp — global "shut up for N minutes" hotkey.
 *   - `appBlacklist` — substring match against the active window's process/title.
 *   - Schedule window — only fire between `start`-`end` hours (heartbeats config).
 */
export const useVisionStore = defineStore('vision', () => {
  const providersStore = useProvidersStore()
  const chatOrchestrator = useChatOrchestratorStore()

  // ── Provider config ────────────────────────────────────────────────────────
  const activeProvider = useLocalStorageManualReset<string>('settings/vision/active-provider', '')
  const activeModel = useLocalStorageManualReset<string>('settings/vision/active-model', '')
  const contextWindow = useLocalStorageManualReset<number>('settings/vision/context-window', 1)
  const promptShim = useLocalStorageManualReset<string>(
    'settings/vision/prompt-shim',
    'Bạn đang đóng vai nhân vật chính nhưng có khả năng nhìn màn hình của {{user}}. Phản ứng tự nhiên, đúng nhân vật, bằng tiếng Việt. Tuyệt đối không bình luận kiểu "tôi đang phân tích/mô tả ảnh". Chỉ phản ứng với những gì bạn thấy như nhân vật của mình sẽ phản ứng.',
  )

  // ── Master kill switch ─────────────────────────────────────────────────────
  /**
   * Hard master switch for ALL vision features. When false:
   *   - Auto modes (Smart, Periodic) cannot fire even if their toggles are on.
   *   - On-demand `/look` and the Ctrl+Shift+V hotkey reply with "I'm not
   *     looking right now" instead of capturing.
   * Use `/vision off` from Discord to flip this remotely.
   */
  const visionMasterEnabled = useLocalStorageManualReset<boolean>('settings/vision/master-enabled', true)

  // ── Capture sources (multi-screen / multi-window) ─────────────────────────
  /**
   * IDs of sources to capture (from `visionListSources`). Each capture cycle
   * iterates this list. Empty = pick primary screen automatically.
   */
  const selectedSourceIds = useLocalStorageManualReset<string[]>('settings/vision/source-ids', [])
  const availableSources = ref<VisionSource[]>([])
  const isLoadingSources = ref(false)
  /** When true, capture all currently visible screens regardless of selection. */
  const captureAllScreens = useLocalStorageManualReset<boolean>('settings/vision/capture-all-screens', false)
  /**
   * Predict mode: at capture time, ask main to pick the screen the user is
   * actively working on (foreground window, fallback to cursor). When this is
   * on, `captureAllScreens` and `selectedSourceIds` are ignored.
   *
   * Three modes form a clean priority ladder:
   *   predict  > captureAllScreens > selectedSourceIds  > primary fallback
   */
  const predictMode = useLocalStorageManualReset<boolean>('settings/vision/predict-mode', true)

  // ── Modes ──────────────────────────────────────────────────────────────────
  /** Bot ALWAYS allows on-demand capture; this controls periodic + smart. */
  const isWitnessEnabled = useLocalStorageManualReset<boolean>('settings/vision/witness-enabled', false)
  const periodicEnabled = useLocalStorageManualReset<boolean>('settings/vision/periodic-enabled', false)
  const periodicIntervalMinutes = useLocalStorageManualReset<number>('settings/vision/periodic-interval-minutes', 5)
  /**
   * Smart mode default OFF. We don't want AIRI to barge in every time the user
   * alt-tabs without explicit consent. They flip it on from Settings → Vision
   * or `/smartmode on` once they're sure they want the proactive vibe.
   */
  const smartEnabled = useLocalStorageManualReset<boolean>('settings/vision/smart-enabled', false)
  /**
   * Smart mode debounce: after detecting an active window change, wait this
   * many milliseconds of stability before capturing. Prevents alt-tab spam.
   */
  const smartDebounceMs = useLocalStorageManualReset<number>('settings/vision/smart-debounce-ms', 4000)

  /**
   * Smart mode cooldown: minimum gap between two smart captures even if the
   * window keeps changing. Tames context-switching workflows.
   *
   * Default 3 min — matches the rule of thumb that AIRI commenting more than
   * once every 3 minutes feels intrusive in normal work.
   */
  const smartCooldownMs = useLocalStorageManualReset<number>('settings/vision/smart-cooldown-ms', 180_000)

  /**
   * Smart mode trigger granularity: how to decide that "the active window has
   * changed enough to warrant a capture".
   *   - `process`: only trigger when the foreground APPLICATION changes
   *     (Chrome → VS Code). Tab/file switches inside the same app are ignored.
   *     This is the calmer default and matches most users' intuition.
   *   - `title`: trigger when the title changes too (catches Chrome tab
   *     switches, VS Code file switches, etc.). Costs more API calls.
   */
  const smartGranularity = useLocalStorageManualReset<'process' | 'title'>('settings/vision/smart-granularity', 'process')

  /**
   * Apps where smart mode should NOT trigger even when switching INTO them.
   * Different from `appBlacklist` which is checked against the active window
   * before any capture; this one is purely a smart-mode "ignore this destination".
   */
  const smartIgnoreApps = useLocalStorageManualReset<string[]>('settings/vision/smart-ignore-apps', [
    'discord',
    'airi',
  ])

  // ── Privacy ────────────────────────────────────────────────────────────────
  /** Substrings (case-insensitive) matched against active window title + processName. */
  const appBlacklist = useLocalStorageManualReset<string[]>('settings/vision/app-blacklist', [
    '1password',
    'bitwarden',
    'keepass',
    'lastpass',
    'banking',
    'password',
  ])
  /** Epoch ms; while now < pausedUntil, all auto captures are skipped. */
  const pausedUntil = useLocalStorageManualReset<number>('settings/vision/paused-until', 0)

  // ── Witness prompts ────────────────────────────────────────────────────────
  const witnessPrompt = useLocalStorageManualReset<string>(
    'settings/vision/witness-prompt',
    'Quan sát kỹ màn hình của {{user}} và phản ứng theo đúng nhân vật, bằng tiếng Việt. Nếu thấy gì thú vị, bình luận một câu ngắn, vui, đúng giọng. Nếu không có gì đáng nói, output NO_REPLY.',
  )
  const onDemandPrompt = useLocalStorageManualReset<string>(
    'settings/vision/on-demand-prompt',
    'Đây là ảnh màn hình {{user}} vừa cho bạn xem. Hãy phản ứng tự nhiên bằng tiếng Việt theo đúng nhân vật.',
  )
  const respectSchedule = useLocalStorageManualReset<boolean>('settings/vision/respect-schedule', true)

  // ── Live state ─────────────────────────────────────────────────────────────
  const status = ref<'idle' | 'capturing'>('idle')
  const lastWitnessTime = ref<number>(0)
  const lastWitnessAnalysis = ref<string>('')
  const lastCapturedSourceName = ref<string>('')
  const lastHeartbeatExec = useLocalStorageManualReset<number>('settings/vision/last-heartbeat', 0)
  const lastSmartExec = ref<number>(0)
  const lastActiveWindowKey = ref<string>('')

  const airiCardStore = useAiriCardStore()
  const { activeCard } = storeToRefs(airiCardStore)

  const isElectron = typeof window !== 'undefined' && !!(window as any).electron
  const captureInvoke = isElectron ? useElectronEventaInvoke(visionCaptureScreen) : null
  const checkPermissionInvoke = isElectron ? useElectronEventaInvoke(visionCheckPermission) : null
  const requestPermissionInvoke = isElectron ? useElectronEventaInvoke(visionRequestPermission) : null
  const listSourcesInvoke = isElectron ? useElectronEventaInvoke(visionListSources) : null
  const getActiveWindowInvoke = isElectron ? useElectronEventaInvoke(sensorsGetActiveWindow) : null

  // ── Permissions ────────────────────────────────────────────────────────────
  async function checkPermissions() {
    if (!checkPermissionInvoke)
      return 'granted'
    try {
      return await checkPermissionInvoke()
    }
    catch (err) {
      console.warn('[Vision] permission check failed (non-mac?):', err)
      return 'granted'
    }
  }

  async function openPermissionSettings() {
    if (requestPermissionInvoke)
      await requestPermissionInvoke()
  }

  // ── Source enumeration ─────────────────────────────────────────────────────
  /**
   * Refresh the list of capturable surfaces. Call from settings UI when the
   * picker opens. Cheap enough to call on demand; we cache the result on the
   * store so multiple components can share without re-IPC.
   */
  async function refreshSources(opts?: { thumbnailWidth?: number, thumbnailHeight?: number }) {
    if (!listSourcesInvoke)
      return []
    isLoadingSources.value = true
    try {
      const sources = await listSourcesInvoke(opts ?? {})
      availableSources.value = sources ?? []
      return availableSources.value
    }
    catch (err) {
      console.warn('[Vision] refreshSources failed:', err)
      availableSources.value = []
      return []
    }
    finally {
      isLoadingSources.value = false
    }
  }

  function toggleSourceSelection(sourceId: string) {
    const set = new Set(selectedSourceIds.value)
    if (set.has(sourceId))
      set.delete(sourceId)
    else
      set.add(sourceId)
    selectedSourceIds.value = Array.from(set)
  }

  /** Resolve which source ids to capture this cycle. */
  function resolveSourceIdsForCapture(): string[] {
    if (captureAllScreens.value) {
      const ids = availableSources.value.filter(s => s.type === 'screen').map(s => s.id)
      if (ids.length > 0)
        return ids
      // Sources not yet enumerated; let main pick the primary screen.
      return ['']
    }
    if (selectedSourceIds.value.length > 0)
      return selectedSourceIds.value
    // Default: primary screen (empty string → main picks default).
    return ['']
  }

  // ── Privacy / pause helpers ────────────────────────────────────────────────
  const isPaused = computed(() => Date.now() < pausedUntil.value)
  const pauseRemainingMinutes = computed(() => {
    if (!isPaused.value)
      return 0
    return Math.max(0, Math.ceil((pausedUntil.value - Date.now()) / 60_000))
  })
  function pauseFor(minutes: number) {
    pausedUntil.value = Date.now() + Math.max(1, minutes) * 60_000
    toast.info(`Vision paused for ${minutes} minute(s).`)
  }
  function pauseIndefinitely() {
    // Year 2099 = effectively forever for any reasonable session lifetime.
    pausedUntil.value = new Date('2099-12-31').getTime()
    toast.info('Vision paused indefinitely. Use /resumevision to bring it back.')
  }
  function resumeNow() {
    pausedUntil.value = 0
    toast.info('Vision resumed.')
  }

  /**
   * Returns true if the active window matches any blacklist entry.
   * We check both the title (e.g. "Vault — 1Password") and the process
   * name (e.g. "1Password.exe") to maximise coverage.
   */
  async function isActiveWindowBlacklisted(): Promise<boolean> {
    if (!getActiveWindowInvoke || appBlacklist.value.length === 0)
      return false

    try {
      const win = await getActiveWindowInvoke()
      if (!win)
        return false
      const haystack = `${win.title ?? ''}\u0000${win.processName ?? ''}`.toLowerCase()
      return appBlacklist.value.some(entry => entry.trim() && haystack.includes(entry.trim().toLowerCase()))
    }
    catch (err) {
      console.warn('[Vision] active window probe failed:', err)
      return false
    }
  }

  function addToBlacklist(entry: string) {
    const cleaned = entry.trim().toLowerCase()
    if (!cleaned)
      return
    if (appBlacklist.value.includes(cleaned))
      return
    appBlacklist.value = [...appBlacklist.value, cleaned]
  }
  function removeFromBlacklist(entry: string) {
    appBlacklist.value = appBlacklist.value.filter(e => e !== entry)
  }

  // ── Core capture ───────────────────────────────────────────────────────────
  /**
   * Capture a single source. Used by all higher-level flows (heartbeat, smart,
   * on-demand). Caller is responsible for permission gating.
   */
  async function captureSnapshot(options?: {
    width?: number
    height?: number
    sourceId?: string
    type?: 'screen' | 'window'
    format?: 'png' | 'jpeg'
    quality?: number
    predict?: 'active'
  }): Promise<ScreenCaptureResult | { error: string } | null> {
    if (!captureInvoke)
      return null

    const permission = await checkPermissions()
    if (permission === 'denied' || permission === 'restricted')
      return { error: 'permission_denied' }

    try {
      const result = await captureInvoke({
        width: options?.width ?? 1280,
        height: options?.height ?? 720,
        sourceId: options?.sourceId,
        type: options?.type ?? (options?.sourceId?.startsWith('window:') ? 'window' : 'screen'),
        format: options?.format ?? 'jpeg',
        quality: options?.quality ?? 70,
        predict: options?.predict,
      })
      return result ?? null
    }
    catch (err) {
      console.error('[Vision] captureSnapshot error:', err)
      return null
    }
  }

  /**
   * Capture every selected source (or whatever predict mode picks) and return
   * them as multimodal attachments ready to ship to chatOrchestrator.
   *
   * Source priority:
   *   1. `predictMode` ON → ask main to resolve the active display.
   *   2. `captureAllScreens` → all enumerated screens.
   *   3. `selectedSourceIds` → the user's pinned list.
   *   4. fallback → primary screen.
   */
  async function captureForLLM(): Promise<{ attachments: { type: 'image', data: string, mimeType: string }[], sourceNames: string[] } | { error: string }> {
    const attachments: { type: 'image', data: string, mimeType: string }[] = []
    const sourceNames: string[] = []

    if (predictMode.value) {
      const result = await captureSnapshot({
        predict: 'active',
        format: 'jpeg',
        quality: 70,
      })
      if (result && 'error' in result) {
        if (result.error === 'permission_denied')
          return { error: 'permission_denied' }
      }
      else if (result?.dataUrl) {
        const match = result.dataUrl.match(/^data:([^;]+);base64,(.*)$/)
        if (match) {
          attachments.push({ type: 'image', data: match[2], mimeType: match[1] })
          if (result.sourceName)
            sourceNames.push(result.sourceName)
        }
      }
    }
    else {
      const ids = resolveSourceIdsForCapture()
      for (const id of ids) {
        const result = await captureSnapshot({
          sourceId: id || undefined,
          format: 'jpeg',
          quality: 70,
        })
        if (result && 'error' in result) {
          if (result.error === 'permission_denied')
            return { error: 'permission_denied' }
          continue
        }
        if (!result?.dataUrl)
          continue

        const match = result.dataUrl.match(/^data:([^;]+);base64,(.*)$/)
        if (!match)
          continue
        attachments.push({ type: 'image', data: match[2], mimeType: match[1] })
        if (result.sourceName)
          sourceNames.push(result.sourceName)
      }
    }

    if (attachments.length === 0)
      return { error: 'no_capture' }

    lastCapturedSourceName.value = sourceNames.join(', ')
    return { attachments, sourceNames }
  }

  // ── Mode 1: On-demand ──────────────────────────────────────────────────────
  /**
   * User-triggered capture (hotkey, slash command, button). Bypasses the
   * witness/periodic/smart gates entirely — only the master kill switch and
   * the global pause flag can block this. The privacy blacklist is applied
   * only when the caller opts in (`respectBlacklist: true`).
   *
   * Returns a status string so callers (Discord slash handlers) can surface
   * a meaningful message when capture was skipped.
   */
  async function captureOnDemand(opts?: { promptOverride?: string, respectBlacklist?: boolean }): Promise<'ok' | 'master_off' | 'paused' | 'blacklisted' | 'permission_denied' | 'no_capture'> {
    if (!visionMasterEnabled.value) {
      toast.info('Vision đang tắt (master switch). Bật lại trong Settings → Vision hoặc dùng `/vision on`.')
      return 'master_off'
    }
    if (isPaused.value) {
      const remaining = pauseRemainingMinutes.value
      toast.info(remaining > 0
        ? `Vision đang pause (~${remaining} phút nữa). Resume bằng /resumevision.`
        : 'Vision đang pause. Resume bằng /resumevision.')
      return 'paused'
    }
    if (opts?.respectBlacklist && await isActiveWindowBlacklisted()) {
      toast.warning('Cửa sổ active đang trong blacklist, bỏ qua capture.')
      return 'blacklisted'
    }

    status.value = 'capturing'
    try {
      const captured = await captureForLLM()
      if ('error' in captured) {
        if (captured.error === 'permission_denied') {
          toast.error('Cấp quyền chia sẻ màn hình trước đã.', {
            action: { label: 'Mở settings', onClick: () => openPermissionSettings() },
          })
          return 'permission_denied'
        }
        toast.warning('Không capture được màn hình nào.')
        return 'no_capture'
      }

      const prompt = opts?.promptOverride ?? onDemandPrompt.value
      lastWitnessTime.value = Date.now()
      await chatOrchestrator.ingest(prompt, { attachments: captured.attachments })
      return 'ok'
    }
    finally {
      status.value = 'idle'
    }
  }

  // ── Mode 2: Periodic (interval) ────────────────────────────────────────────
  let periodicHandle: ReturnType<typeof useIntervalFn> | null = null

  async function periodicTick() {
    if (!visionMasterEnabled.value)
      return
    if (!periodicEnabled.value || !isWitnessEnabled.value)
      return
    if (isPaused.value)
      return
    if (await isActiveWindowBlacklisted())
      return

    // Cooldown: enforce at least the configured interval, with a small drift buffer
    // to account for cross-window setInterval spread.
    const now = Date.now()
    const intervalMs = Math.max(1, periodicIntervalMinutes.value) * 60_000
    if (now - lastHeartbeatExec.value < intervalMs - 5_000)
      return
    lastHeartbeatExec.value = now

    if (respectSchedule.value) {
      const schedule = activeCard.value?.extensions?.airi?.heartbeats?.schedule
      if (schedule?.start && schedule?.end && !isWithinSchedule(schedule.start, schedule.end))
        return
    }

    await runWitnessCapture('periodic')
  }

  /**
   * Run an automated witness capture. Used by both periodic and smart modes.
   * The reason string is for logging only.
   */
  async function runWitnessCapture(reason: 'periodic' | 'smart') {
    status.value = 'capturing'
    try {
      const captured = await captureForLLM()
      if ('error' in captured) {
        if (captured.error === 'permission_denied') {
          toast.error('Vision permission denied.', {
            action: { label: 'Fix', onClick: () => openPermissionSettings() },
          })
        }
        return
      }
      lastWitnessTime.value = Date.now()
      console.info(`[Vision] ${reason} witness fired (${captured.attachments.length} sources, ${captured.sourceNames.join(', ')})`)
      await chatOrchestrator.ingest(witnessPrompt.value, { attachments: captured.attachments })
    }
    finally {
      status.value = 'idle'
    }
  }

  function startPeriodicLoop() {
    if (periodicHandle)
      return
    periodicHandle = useIntervalFn(periodicTick, 30_000, { immediate: false })
    periodicHandle.resume()
  }
  function stopPeriodicLoop() {
    periodicHandle?.pause()
    periodicHandle = null
  }

  watch(periodicEnabled, (enabled) => {
    if (enabled && isWitnessEnabled.value)
      startPeriodicLoop()
    else
      stopPeriodicLoop()
  }, { immediate: false })
  watch(isWitnessEnabled, (enabled) => {
    if (enabled && periodicEnabled.value)
      startPeriodicLoop()
    else
      stopPeriodicLoop()
  }, { immediate: false })

  // ── Mode 3: Smart (active-window-change driven) ────────────────────────────
  let smartProbeHandle: ReturnType<typeof useIntervalFn> | null = null
  let pendingDebounce: ReturnType<typeof setTimeout> | null = null

  async function smartProbeTick() {
    if (!visionMasterEnabled.value)
      return
    if (!smartEnabled.value || !isWitnessEnabled.value)
      return
    if (isPaused.value)
      return
    if (!getActiveWindowInvoke)
      return

    // Leadership election — only the Stage window drives the probe. With
    // multiple BrowserWindows alive (Stage + Settings + Caption + …) every one
    // of them runs `useIntervalFn` independently, which without this gate
    // would multiply smart captures by the window count.
    if (typeof window !== 'undefined') {
      const hash = window.location.hash || '#/'
      const isStageWindow = hash === '#/' || hash.startsWith('#/stage')
      if (!isStageWindow)
        return
    }

    let win: any
    try {
      win = await getActiveWindowInvoke()
    }
    catch {
      return
    }
    if (!win)
      return

    // Build the comparison key according to the configured granularity. With
    // `process` (default), title changes inside the same app don't count as
    // a "window change" — keeps the probe quiet during normal browsing/IDE work.
    const proc = (win.processName ?? '').toLowerCase()
    const titleLower = (win.title ?? '').toLowerCase()
    const key = smartGranularity.value === 'title'
      ? `${proc}\u0000${titleLower}`
      : proc

    if (!key || key === lastActiveWindowKey.value)
      return
    lastActiveWindowKey.value = key

    // Smart-mode "ignore destination" filter: when the user switches INTO one
    // of these apps, we just update the key (so we don't re-trigger when they
    // leave) but don't fire a capture. Distinct from the privacy blacklist,
    // which simply skips capture if the active window matches.
    const ignoreHit = smartIgnoreApps.value.some(entry => entry.trim() && (proc.includes(entry.trim().toLowerCase()) || titleLower.includes(entry.trim().toLowerCase())))
    if (ignoreHit)
      return

    // Window changed — schedule a debounced capture. If another change comes
    // before the timer fires, we reset, so rapid alt-tabbing doesn't spam.
    if (pendingDebounce)
      clearTimeout(pendingDebounce)

    pendingDebounce = setTimeout(async () => {
      pendingDebounce = null

      if (isPaused.value)
        return
      if (Date.now() - lastSmartExec.value < smartCooldownMs.value)
        return
      if (await isActiveWindowBlacklisted())
        return
      if (respectSchedule.value) {
        const schedule = activeCard.value?.extensions?.airi?.heartbeats?.schedule
        if (schedule?.start && schedule?.end && !isWithinSchedule(schedule.start, schedule.end))
          return
      }

      lastSmartExec.value = Date.now()
      await runWitnessCapture('smart')
    }, Math.max(500, smartDebounceMs.value))
  }

  function startSmartLoop() {
    if (smartProbeHandle)
      return
    smartProbeHandle = useIntervalFn(smartProbeTick, 2_000, { immediate: false })
    smartProbeHandle.resume()
  }
  function stopSmartLoop() {
    smartProbeHandle?.pause()
    smartProbeHandle = null
    if (pendingDebounce) {
      clearTimeout(pendingDebounce)
      pendingDebounce = null
    }
  }

  watch(smartEnabled, (enabled) => {
    if (enabled && isWitnessEnabled.value)
      startSmartLoop()
    else
      stopSmartLoop()
  })
  watch(isWitnessEnabled, (enabled) => {
    if (enabled && smartEnabled.value)
      startSmartLoop()
    else
      stopSmartLoop()
  }, { immediate: true })

  // Boot loops if witness was already enabled when store mounted.
  if (isElectron && isWitnessEnabled.value) {
    if (periodicEnabled.value)
      startPeriodicLoop()
    if (smartEnabled.value)
      startSmartLoop()
  }

  // ── Provider/model UI helpers ──────────────────────────────────────────────
  const supportsModelListing = computed(() => providersStore.getProviderMetadata(activeProvider.value)?.capabilities.listModels !== undefined)
  const providerModels = computed(() => providersStore.getModelsForProvider(activeProvider.value))
  const isLoadingActiveProviderModels = computed(() => providersStore.isLoadingModels[activeProvider.value] || false)
  const activeProviderModelError = computed(() => providersStore.modelLoadError[activeProvider.value] || null)

  function resetModelSelection() {
    activeModel.reset()
  }
  async function loadModelsForProvider(provider: string) {
    if (provider && providersStore.getProviderMetadata(provider)?.capabilities.listModels !== undefined)
      await providersStore.fetchModelsForProvider(provider)
  }
  async function getModelsForProvider(provider: string) {
    if (provider && providersStore.getProviderMetadata(provider)?.capabilities.listModels !== undefined)
      return providersStore.getModelsForProvider(provider)
    return []
  }

  const configured = computed(() => !!activeProvider.value && !!activeModel.value)

  function resetState() {
    activeProvider.reset()
    resetModelSelection()
    contextWindow.reset()
  }

  watch(activeProvider, () => {
    if (Object.keys(providersStore.providerMetadata).length > 0 && activeProvider.value && !providersStore.providerMetadata[activeProvider.value]) {
      activeProvider.value = ''
      resetModelSelection()
    }
  }, { immediate: true })

  // ── Global hotkey integration ──────────────────────────────────────────────
  /**
   * The main process registers global hotkeys (Ctrl+Shift+V for capture,
   * Ctrl+Shift+P for pause-toggle) and forwards keystrokes here. We treat the
   * Stage window as the leader so multiple BrowserWindows don't fire duplicate
   * captures — same pattern as the Discord inbound message dispatch.
   */
  if (isElectron) {
    const ipcRenderer = (window as any).electron?.ipcRenderer
    if (ipcRenderer) {
      const isStageWindow = () => {
        const hash = window.location.hash || '#/'
        return hash === '#/' || hash.startsWith('#/stage')
      }

      ipcRenderer.on('vision-hotkey:look', () => {
        if (!isStageWindow())
          return
        if (!visionMasterEnabled.value) {
          toast.info('Vision đang tắt (master switch). Bật bằng Settings hoặc /vision on.')
          return
        }
        if (!configured.value) {
          toast.warning('Vision provider chưa được cấu hình.')
          return
        }
        void captureOnDemand({ respectBlacklist: false })
      })

      ipcRenderer.on('vision-hotkey:pause-toggle', () => {
        if (!isStageWindow())
          return
        if (isPaused.value)
          resumeNow()
        else
          pauseFor(15)
      })
    }
  }

  onUnmounted(() => {
    stopPeriodicLoop()
    stopSmartLoop()
  })

  // ── Legacy heartbeat compat (kept so old proactivity code doesn't break) ──
  async function heartbeat(options?: { force?: boolean }) {
    const liveSessionStore = useLiveSessionStore()
    if (!options?.force) {
      if (!liveSessionStore.isActive)
        return
      if (!isWitnessEnabled.value)
        return
    }

    if (options?.force) {
      await captureOnDemand()
      return
    }
    await periodicTick()
  }

  function toggleWitness() {
    isWitnessEnabled.value = !isWitnessEnabled.value
  }

  /**
   * Flip the master kill switch. When turning OFF we also stop the auto loops
   * eagerly so we don't waste a tick before the watch fires.
   */
  function setMasterEnabled(enabled: boolean) {
    visionMasterEnabled.value = enabled
    if (!enabled) {
      stopPeriodicLoop()
      stopSmartLoop()
    }
    else {
      // Re-arm whatever the user had configured.
      if (isWitnessEnabled.value && periodicEnabled.value)
        startPeriodicLoop()
      if (isWitnessEnabled.value && smartEnabled.value)
        startSmartLoop()
    }
  }

  return {
    // Provider config
    configured,
    activeProvider,
    activeModel,
    contextWindow,
    promptShim,

    // Sources
    selectedSourceIds,
    availableSources,
    isLoadingSources,
    captureAllScreens,
    predictMode,
    refreshSources,
    toggleSourceSelection,

    // Modes
    isWitnessEnabled,
    periodicEnabled,
    periodicIntervalMinutes,
    smartEnabled,
    smartDebounceMs,
    smartCooldownMs,
    smartGranularity,
    smartIgnoreApps,

    // Privacy
    appBlacklist,
    pausedUntil,
    isPaused,
    pauseRemainingMinutes,
    pauseFor,
    pauseIndefinitely,
    resumeNow,
    addToBlacklist,
    removeFromBlacklist,

    // Master switch
    visionMasterEnabled,
    setMasterEnabled,

    // Witness prompts
    witnessPrompt,
    onDemandPrompt,
    respectSchedule,

    // Live state
    status,
    lastWitnessTime,
    lastWitnessAnalysis,
    lastCapturedSourceName,

    // Provider helpers
    supportsModelListing,
    providerModels,
    isLoadingActiveProviderModels,
    activeProviderModelError,
    resetModelSelection,
    loadModelsForProvider,
    getModelsForProvider,

    // Actions
    captureSnapshot,
    captureForLLM,
    captureOnDemand,
    heartbeat,
    toggleWitness,
    checkPermissions,
    openPermissionSettings,
    resetState,
  }
})
