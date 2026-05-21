import type { Buffer } from 'node:buffer'

import { useLogg } from '@guiiai/logg'

import {
  BARGE_IN_CONFIRM_FRAMES,
  BARGE_IN_COOLDOWN_MS,
  BARGE_IN_RMS_THRESHOLD,
} from '../constants/audio'

/**
 * Detects when a user is actively speaking while the bot is playing audio (barge-in).
 *
 * Uses RMS energy analysis with consecutive-frame confirmation to avoid
 * false positives from transient noise spikes. Includes a cooldown period
 * after each barge-in to prevent rapid re-triggers.
 */
export class BargeInDetector {
  private logger = useLogg('BargeInDetector').useGlobalConfig()
  private consecutiveFramesAbove = 0
  private lastBargeInTime = 0
  private enabled = true

  private rmsThreshold: number
  private confirmFrames: number
  private cooldownMs: number

  constructor(options?: {
    rmsThreshold?: number
    confirmFrames?: number
    cooldownMs?: number
  }) {
    this.rmsThreshold = options?.rmsThreshold ?? BARGE_IN_RMS_THRESHOLD
    this.confirmFrames = options?.confirmFrames ?? BARGE_IN_CONFIRM_FRAMES
    this.cooldownMs = options?.cooldownMs ?? BARGE_IN_COOLDOWN_MS
  }

  /**
   * Feed a PCM buffer (16-bit signed LE) and check if barge-in should trigger.
   * Call this for every decoded PCM frame while the bot is playing audio.
   *
   * @returns `true` if barge-in detected (user is speaking over the bot)
   */
  process(pcmBuffer: Buffer): boolean {
    if (!this.enabled)
      return false

    // Cooldown check
    const now = Date.now()
    if (now - this.lastBargeInTime < this.cooldownMs) {
      return false
    }

    const rms = this.computeRms(pcmBuffer)

    if (rms > this.rmsThreshold) {
      this.consecutiveFramesAbove++

      if (this.consecutiveFramesAbove >= this.confirmFrames) {
        this.lastBargeInTime = now
        this.consecutiveFramesAbove = 0
        this.logger.withField('rms', rms.toFixed(4)).log('Barge-in triggered')
        return true
      }
    }
    else {
      // Reset counter on silence frame
      this.consecutiveFramesAbove = 0
    }

    return false
  }

  /** Reset internal state (e.g. when bot stops playing). */
  reset() {
    this.consecutiveFramesAbove = 0
  }

  /** Temporarily disable detection (e.g. during cooldown or special states). */
  setEnabled(enabled: boolean) {
    this.enabled = enabled
    if (!enabled)
      this.reset()
  }

  /**
   * Compute RMS (Root Mean Square) energy of a 16-bit PCM buffer.
   * Returns a value between 0 and 1.
   */
  private computeRms(pcmBuffer: Buffer): number {
    const samples = new Int16Array(
      pcmBuffer.buffer,
      pcmBuffer.byteOffset,
      pcmBuffer.byteLength / 2,
    )

    if (samples.length === 0)
      return 0

    let sumSquares = 0
    for (let i = 0; i < samples.length; i++) {
      const normalized = samples[i] / 32768
      sumSquares += normalized * normalized
    }

    return Math.sqrt(sumSquares / samples.length)
  }
}
