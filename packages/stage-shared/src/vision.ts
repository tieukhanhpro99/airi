import { defineInvokeEventa } from '@moeru/eventa'

export interface ScreenCaptureOptions {
  width?: number
  height?: number
  type?: 'screen' | 'window'
  sourceId?: string
  /**
   * Output format. JPEG is ~5x smaller than PNG for screen content and
   * crosses IPC boundaries faster — recommended for periodic captures.
   * Defaults to PNG for backwards compatibility.
   */
  format?: 'png' | 'jpeg'
  /** JPEG quality 1-100. Ignored for PNG. Defaults to 70. */
  quality?: number
  /**
   * Dynamic source resolution. When set, `sourceId` and `type` are ignored
   * and main picks the source based on a runtime heuristic:
   *   - 'active': the display containing the foreground window. Falls back
   *     to the display under the cursor, then to the primary display.
   * Use this for "predict mode" so multi-monitor users always get the screen
   * they're actually working on without having to maintain a source list.
   */
  predict?: 'active'
}

export interface ScreenCaptureResult {
  dataUrl: string
  timestamp: number
  /** ID of the source that produced this capture; useful when capturing multiple. */
  sourceId?: string
  /** Display/window name as reported by Electron. */
  sourceName?: string
}

/** Metadata about a capturable surface (screen or window). */
export interface VisionSource {
  id: string
  name: string
  type: 'screen' | 'window'
  /**
   * Small (~256px) JPEG thumbnail data URL for the source picker UI.
   * NOTICE: Recomputed each call to `visionListSources` so the preview
   * reflects current desktop state.
   */
  thumbnailDataUrl: string
  /** Display ID for screens (e.g. for matching with Electron's `Display.id`). */
  displayId?: string
  /**
   * For windows only: best-effort owning process name (e.g. "code.exe").
   * Used by the privacy blacklist. May be empty on platforms where
   * desktopCapturer doesn't expose appIcon/owner info.
   */
  appName?: string
}

export const visionCaptureScreen = defineInvokeEventa<ScreenCaptureResult | null, ScreenCaptureOptions | undefined>('eventa:invoke:electron:vision:capture-screen')

export const visionCheckPermission = defineInvokeEventa<'granted' | 'denied' | 'restricted' | 'unknown', never>('eventa:invoke:electron:vision:check-permission')
export const visionRequestPermission = defineInvokeEventa<void, never>('eventa:invoke:electron:vision:request-permission')

/**
 * Enumerate available capture surfaces (all monitors + all open windows).
 * The result includes small JPEG thumbnails so the renderer can present a
 * picker UI without making per-source IPC calls.
 */
export const visionListSources = defineInvokeEventa<VisionSource[], { thumbnailWidth?: number, thumbnailHeight?: number } | undefined>(
  'eventa:invoke:electron:vision:list-sources',
)
