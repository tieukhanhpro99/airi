import type { Readable } from 'node:stream'

import { Buffer } from 'node:buffer'

import { useLogg } from '@guiiai/logg'

import {
  DECODE_SAMPLE_RATE,
  STT_CHUNK_MAX_DURATION_MS,
  STT_CHUNK_MIN_DURATION_MS,
  STT_SILENCE_RMS_THRESHOLD,
  STT_SILENCE_THRESHOLD_MS,
} from '../constants/audio'
import { openaiTranscribe } from '../pipelines/tts'
import { getWavHeader } from './audio'

export interface StreamingTranscriberOptions {
  /** Callback when a transcript chunk is ready. */
  onTranscript: (text: string) => void
  /** Callback when the user starts speaking (first audio above threshold). */
  onSpeechStart?: () => void
  /** Callback when the user stops speaking (silence detected or stream ends). */
  onSpeechEnd?: () => void
  /** Minimum chunk duration in ms before sending to STT. */
  minChunkMs?: number
  /** Maximum chunk duration in ms (force-flush). */
  maxChunkMs?: number
  /** Silence duration in ms to trigger end-of-utterance flush. */
  silenceMs?: number
  /** RMS threshold for silence detection. */
  silenceRmsThreshold?: number
}

/**
 * Streaming STT transcriber that sends audio chunks to speaches as soon as
 * meaningful speech segments are detected, rather than waiting for the entire
 * utterance to complete.
 *
 * Flow:
 * 1. Receives PCM data from OpusDecoder stream
 * 2. Detects speech onset via RMS energy
 * 3. Accumulates audio until either:
 *    - Silence detected for `silenceMs` → flush chunk
 *    - Max duration reached → flush chunk
 * 4. Sends chunk to speaches `/v1/audio/transcriptions`
 * 5. Calls `onTranscript` with the result
 *
 * This reduces latency by ~1-2s compared to the old approach of waiting
 * for the full utterance + 1.5s debounce.
 */
export class StreamingTranscriber {
  private logger = useLogg('StreamingSTT').useGlobalConfig()

  private buffers: Buffer[] = []
  private totalBytes = 0
  private isSpeaking = false
  private silenceStartTime = 0
  private speechStartTime = 0
  private lastDataTime = 0
  private destroyed = false
  private flushTimer: NodeJS.Timeout | null = null
  private pendingTranscriptions = 0

  private onTranscript: (text: string) => void
  private onSpeechStart?: () => void
  private onSpeechEnd?: () => void

  private minChunkMs: number
  private maxChunkMs: number
  private silenceMs: number
  private silenceRmsThreshold: number

  constructor(options: StreamingTranscriberOptions) {
    this.onTranscript = options.onTranscript
    this.onSpeechStart = options.onSpeechStart
    this.onSpeechEnd = options.onSpeechEnd
    this.minChunkMs = options.minChunkMs ?? STT_CHUNK_MIN_DURATION_MS
    this.maxChunkMs = options.maxChunkMs ?? STT_CHUNK_MAX_DURATION_MS
    this.silenceMs = options.silenceMs ?? STT_SILENCE_THRESHOLD_MS
    this.silenceRmsThreshold = options.silenceRmsThreshold ?? STT_SILENCE_RMS_THRESHOLD
  }

  /**
   * Attach to a PCM audio stream (output of OpusDecoder).
   * Handles 'data', 'end', 'speakingStarted', 'speakingStopped' events.
   */
  attach(stream: Readable) {
    stream.on('data', (chunk: Buffer) => this.handleData(chunk))
    stream.on('end', () => this.handleStreamEnd())
    stream.on('speakingStarted', () => this.handleSpeakingStarted())
    stream.on('speakingStopped', () => this.handleSpeakingStopped())
  }

  /** Process incoming PCM data. */
  private handleData(pcmChunk: Buffer) {
    if (this.destroyed)
      return

    this.lastDataTime = Date.now()
    const rms = this.computeRms(pcmChunk)

    if (!this.isSpeaking) {
      // Detect speech onset
      if (rms > this.silenceRmsThreshold) {
        this.isSpeaking = true
        this.speechStartTime = Date.now()
        this.silenceStartTime = 0
        this.onSpeechStart?.()
        this.logger.log('Speech detected, starting chunk accumulation')
      }
      else {
        // Still silence, don't accumulate
        return
      }
    }

    // Accumulate audio
    this.buffers.push(pcmChunk)
    this.totalBytes += pcmChunk.length

    // Check if this frame is silence
    if (rms <= this.silenceRmsThreshold) {
      if (this.silenceStartTime === 0) {
        this.silenceStartTime = Date.now()
      }

      const silenceDuration = Date.now() - this.silenceStartTime
      const chunkDuration = Date.now() - this.speechStartTime

      // Flush if we have enough audio and silence threshold is met
      if (silenceDuration >= this.silenceMs && chunkDuration >= this.minChunkMs) {
        this.flushChunk('silence')
        return
      }
    }
    else {
      // Reset silence timer on speech
      this.silenceStartTime = 0
    }

    // Force-flush if max duration reached
    const chunkDuration = Date.now() - this.speechStartTime
    if (chunkDuration >= this.maxChunkMs) {
      this.flushChunk('max-duration')
    }
  }

  /** Discord speaking event: user started talking. */
  private handleSpeakingStarted() {
    if (this.destroyed)
      return

    // Clear any pending flush timer
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }

    // Reset state for new utterance
    this.buffers = []
    this.totalBytes = 0
    this.isSpeaking = false
    this.silenceStartTime = 0
  }

  /** Discord speaking event: user stopped talking. */
  private handleSpeakingStopped() {
    if (this.destroyed)
      return

    // Flush whatever we have after a short delay (in case of brief pause)
    this.flushTimer = setTimeout(() => {
      if (this.buffers.length > 0) {
        this.flushChunk('speaking-stopped')
      }
      this.isSpeaking = false
      this.onSpeechEnd?.()
    }, 200) // 200ms grace period for brief pauses
  }

  /** Stream ended (user left or connection dropped). */
  private handleStreamEnd() {
    if (this.buffers.length > 0) {
      this.flushChunk('stream-end')
    }
    this.isSpeaking = false
    this.onSpeechEnd?.()
  }

  /**
   * Send accumulated audio to STT and reset buffers.
   * Runs transcription async — doesn't block the audio pipeline.
   */
  private flushChunk(reason: string) {
    if (this.buffers.length === 0)
      return

    const pcmData = Buffer.concat(this.buffers, this.totalBytes)
    const durationMs = (pcmData.length / 2) / DECODE_SAMPLE_RATE * 1000 // 16-bit = 2 bytes per sample

    // Don't send tiny chunks (< 300ms) — likely just noise
    if (durationMs < 300) {
      this.logger.log(`Skipping tiny chunk (${durationMs.toFixed(0)}ms)`)
      this.resetBuffers()
      return
    }

    this.logger.withFields({ reason, durationMs: durationMs.toFixed(0) })
      .log('Flushing audio chunk to STT')

    // Reset buffers immediately so new audio can accumulate
    this.resetBuffers()

    // Fire-and-forget transcription (don't block audio pipeline)
    this.pendingTranscriptions++
    this.transcribeChunk(pcmData)
      .finally(() => { this.pendingTranscriptions-- })
  }

  /** Convert PCM to WAV and send to speaches. */
  private async transcribeChunk(pcmData: Buffer) {
    try {
      // Build WAV from raw PCM
      const wavHeader = getWavHeader(pcmData.length, DECODE_SAMPLE_RATE)
      const wavBuffer = Buffer.concat([wavHeader, pcmData])

      const text = await openaiTranscribe(wavBuffer)

      if (text && this.isValidTranscription(text)) {
        this.onTranscript(text)
      }
    }
    catch (error) {
      this.logger.withError(error).error('Streaming transcription failed')
    }
  }

  private isValidTranscription(text: string): boolean {
    if (!text)
      return false
    if (text.includes('[BLANK_AUDIO]'))
      return false
    // Filter out common Whisper hallucinations on short audio
    const trimmed = text.trim()
    if (trimmed.length < 2)
      return false
    if (/^[.!?,;:\s]+$/.test(trimmed))
      return false
    return true
  }

  private resetBuffers() {
    this.buffers = []
    this.totalBytes = 0
    this.isSpeaking = false
    this.silenceStartTime = 0
    this.speechStartTime = 0
  }

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

  /** Check if there are still pending transcriptions in flight. */
  get hasPendingTranscriptions(): boolean {
    return this.pendingTranscriptions > 0
  }

  /** Clean up resources. */
  destroy() {
    this.destroyed = true
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    this.buffers = []
    this.totalBytes = 0
  }
}
