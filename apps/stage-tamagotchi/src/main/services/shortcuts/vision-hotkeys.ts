import type { BrowserWindow } from 'electron'

import { globalShortcut } from 'electron'

/**
 * Default global hotkeys for vision control. Both can be remapped later via
 * settings; the renderer is the source of truth for "what the keys mean", we
 * just listen for the keystroke and forward to the focused renderer surface.
 */
export const VISION_LOOK_ACCEL = 'CommandOrControl+Shift+V'
export const VISION_PAUSE_ACCEL = 'CommandOrControl+Shift+P'

/**
 * Channel names sent to the renderer. The vision store subscribes to these
 * via `ipcRenderer.on(...)` and dispatches the appropriate action.
 */
export const VISION_LOOK_CHANNEL = 'vision-hotkey:look'
export const VISION_PAUSE_CHANNEL = 'vision-hotkey:pause-toggle'

let registered = false

export function setupVisionHotkeys(window: BrowserWindow) {
  // Re-entry safe: if called twice, unregister our keys first.
  cleanupVisionHotkeys()

  // We schedule registration on the next tick to dodge the same Electron 40.x
  // "unreachable code" V8 fatal that the mic-toggle service worked around.
  setTimeout(() => {
    try {
      const lookOk = globalShortcut.register(VISION_LOOK_ACCEL, () => {
        if (!window.isDestroyed())
          window.webContents.send(VISION_LOOK_CHANNEL, { timestamp: Date.now() })
      })
      if (!lookOk)
        console.warn(`[Vision Hotkeys] Failed to register ${VISION_LOOK_ACCEL}. Another app may already own it.`)

      const pauseOk = globalShortcut.register(VISION_PAUSE_ACCEL, () => {
        if (!window.isDestroyed())
          window.webContents.send(VISION_PAUSE_CHANNEL, { timestamp: Date.now() })
      })
      if (!pauseOk)
        console.warn(`[Vision Hotkeys] Failed to register ${VISION_PAUSE_ACCEL}. Another app may already own it.`)

      registered = lookOk || pauseOk
    }
    catch (err) {
      console.error('[Vision Hotkeys] register failed:', err)
    }
  }, 100)
}

export function cleanupVisionHotkeys() {
  if (!registered)
    return
  try {
    globalShortcut.unregister(VISION_LOOK_ACCEL)
    globalShortcut.unregister(VISION_PAUSE_ACCEL)
  }
  catch { /* noop */ }
  registered = false
}
