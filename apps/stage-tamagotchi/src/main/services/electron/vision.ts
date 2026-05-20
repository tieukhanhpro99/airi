import type { VisionSource } from '@proj-airi/stage-shared'

import { createRequire } from 'node:module'

import { defineInvokeHandler } from '@moeru/eventa'
import {
  visionCaptureScreen,
  visionCheckPermission,
  visionListSources,
  visionRequestPermission,
} from '@proj-airi/stage-shared'
import { desktopCapturer, screen } from 'electron'

import * as ScreenCapture from '@proj-airi/electron-screen-capture/main'

const {
  checkMacOSScreenCapturePermission,
  requestMacOSScreenCapturePermission,
} = ScreenCapture as any

// `active-win` is a CJS native module; load lazily so the rest of the vision
// service still works if it's missing on this platform/build.
const require = createRequire(import.meta.url)
let activeWindow: (() => Promise<any>) | null = null
try {
  const mod = require('active-win')
  activeWindow = typeof mod.activeWindow === 'function' ? mod.activeWindow : (typeof mod === 'function' ? mod : null)
}
catch {
  // active-win not available; predict mode will fall back to cursor-only.
  activeWindow = null
}

/**
 * Convert a NativeImage thumbnail to a data URL using the requested format.
 * JPEG is dramatically smaller for screen content so we prefer it for periodic
 * captures. PNG is kept as default for backwards compatibility with the
 * existing witness pipeline.
 */
function thumbnailToDataUrl(thumbnail: Electron.NativeImage, format: 'png' | 'jpeg', quality: number): string {
  if (thumbnail.isEmpty())
    return ''

  if (format === 'jpeg') {
    const jpeg = thumbnail.toJPEG(Math.max(1, Math.min(100, quality)))
    return `data:image/jpeg;base64,${jpeg.toString('base64')}`
  }

  return thumbnail.toDataURL()
}

/**
 * Screen capture service. Exposes:
 *  - permission check/request (macOS specifically)
 *  - source enumeration with thumbnails (for UI source picker)
 *  - single capture by source id with format/quality knobs
 */
export function createVisionService(params: { context: any }) {
  defineInvokeHandler(params.context, visionCheckPermission, async () => {
    try {
      return checkMacOSScreenCapturePermission()
    }
    catch {
      return 'granted'
    }
  })

  defineInvokeHandler(params.context, visionRequestPermission, async () => {
    try {
      requestMacOSScreenCapturePermission()
    }
    catch { /* non-macOS */ }
  })

  defineInvokeHandler(params.context, visionListSources, async (options) => {
    const thumbWidth = options?.thumbnailWidth ?? 256
    const thumbHeight = options?.thumbnailHeight ?? 144

    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: thumbWidth, height: thumbHeight },
        // Fetch only basic metadata; expensive fields are fetched lazily by capture.
        fetchWindowIcons: false,
      })

      // Build a map of display IDs by area so we can label monitors usefully
      // ("Display 1 (Primary)", "Display 2") instead of OS-supplied generic names.
      const displays = screen.getAllDisplays()
      const primaryDisplayId = String(screen.getPrimaryDisplay().id)

      const result: VisionSource[] = sources.map((src) => {
        const isScreen = src.id.startsWith('screen:')
        let displayId: string | undefined
        let label = src.name

        if (isScreen && src.display_id) {
          displayId = src.display_id
          // The desktopCapturer returns names like "Screen 1" already on most
          // platforms; we suffix the primary marker for clarity.
          if (displayId === primaryDisplayId)
            label = `${src.name} (Primary)`
        }

        return {
          id: src.id,
          name: label,
          type: isScreen ? 'screen' : 'window',
          thumbnailDataUrl: thumbnailToDataUrl(src.thumbnail, 'jpeg', 70),
          displayId,
          appName: undefined,
        }
      })

      // Stable order: primary screen → other screens → windows alphabetical
      result.sort((a, b) => {
        if (a.type !== b.type)
          return a.type === 'screen' ? -1 : 1
        if (a.type === 'screen') {
          if (a.displayId === primaryDisplayId)
            return -1
          if (b.displayId === primaryDisplayId)
            return 1
        }
        return a.name.localeCompare(b.name)
      })

      // NOTICE: We unset `displays` to avoid TS unused warnings; useful future
      // hook for matching to bounds/scale factors.
      void displays

      return result
    }
    catch (err) {
      console.error('[Vision Service] visionListSources failed:', err)
      return []
    }
  })

  defineInvokeHandler(params.context, visionCaptureScreen, async (options) => {
    try {
      // ── Resolve target source id ──────────────────────────────────────────
      // Predict mode: pick the desktopCapturer screen source that matches
      // the display the user is actively working on. We try in order:
      //   1. Display containing the foreground window (via active-win bounds).
      //   2. Display under the cursor.
      //   3. The primary display.
      let resolvedSourceId = options?.sourceId

      if (options?.predict === 'active') {
        const targetDisplay = await resolveActiveDisplay()
        if (targetDisplay) {
          // desktopCapturer source IDs look like `screen:<display_id>:0`. We
          // could match by `display_id`, but to keep this resilient when ids
          // get re-mapped between calls we re-enumerate and match by id field.
          const screens = await desktopCapturer.getSources({
            types: ['screen'],
            thumbnailSize: { width: 1, height: 1 },
          })
          const match = screens.find(s => s.display_id === String(targetDisplay.id))
          if (match)
            resolvedSourceId = match.id
        }
      }

      const types: ('screen' | 'window')[] = options?.type === 'window' ? ['window'] : ['screen']
      const sources = await desktopCapturer.getSources({
        types,
        thumbnailSize: {
          width: options?.width || 1280,
          height: options?.height || 720,
        },
      })

      if (!sources || sources.length === 0)
        return null

      let selectedSource = resolvedSourceId
        ? sources.find(s => s.id === resolvedSourceId)
        : sources[0]

      if (!selectedSource && sources.length > 0) {
        selectedSource = sources.find(s => s.name.toLowerCase().includes('screen') || s.id.startsWith('screen:')) || sources[0]
      }

      if (!selectedSource)
        return null

      const format = options?.format ?? 'png'
      const quality = options?.quality ?? 70
      const dataUrl = thumbnailToDataUrl(selectedSource.thumbnail, format, quality)

      if (!dataUrl || dataUrl.length < 1000)
        console.warn('[Vision Service] Captured thumbnail data is suspiciously small or empty.')

      return {
        dataUrl,
        timestamp: Date.now(),
        sourceId: selectedSource.id,
        sourceName: selectedSource.name,
      }
    }
    catch (err) {
      console.error('[Vision Service] Capture failed in Main process:', err)
      return null
    }
  })
}

/**
 * Find the Electron `Display` the user is currently working on.
 *
 * Priority order:
 *   1. Display containing the foreground window (via `active-win`'s bounds).
 *      This is the "you're typing into something on this monitor" case.
 *   2. Display under the cursor.
 *      Catches the case where the foreground window is fullscreen on one
 *      monitor but the user is currently looking at another (e.g. mouse hover
 *      on a secondary monitor).
 *   3. Primary display (final fallback).
 *
 * Returns null only if `screen` itself fails, which would indicate a far worse
 * problem than vision being on the wrong monitor.
 */
async function resolveActiveDisplay(): Promise<Electron.Display | null> {
  try {
    if (activeWindow) {
      const win = await activeWindow().catch(() => null)
      const bounds = win?.bounds
      if (bounds && typeof bounds.x === 'number' && typeof bounds.y === 'number' && typeof bounds.width === 'number' && typeof bounds.height === 'number') {
        // Use the centre of the window for matching — robust against windows
        // partially spanning two monitors (centre wins).
        const centerX = Math.round(bounds.x + bounds.width / 2)
        const centerY = Math.round(bounds.y + bounds.height / 2)
        const display = screen.getDisplayNearestPoint({ x: centerX, y: centerY })
        if (display)
          return display
      }
    }

    const cursorPoint = screen.getCursorScreenPoint()
    const cursorDisplay = screen.getDisplayNearestPoint(cursorPoint)
    if (cursorDisplay)
      return cursorDisplay

    return screen.getPrimaryDisplay()
  }
  catch (err) {
    console.warn('[Vision Service] resolveActiveDisplay failed:', err)
    return screen.getPrimaryDisplay()
  }
}
