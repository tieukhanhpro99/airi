// These values are chosen for compatibility with picovoice components
export const DECODE_FRAME_SIZE = 1024
export const DECODE_SAMPLE_RATE = 16000

// ── Barge-in Detection ───────────────────────────────────────────────────────

/** RMS energy threshold to consider the user is actively speaking (0-1 scale). */
export const BARGE_IN_RMS_THRESHOLD = 0.04

/** Number of consecutive frames above threshold before triggering barge-in. */
export const BARGE_IN_CONFIRM_FRAMES = 3

/** Cooldown (ms) after a barge-in before another can trigger. Prevents rapid re-triggers. */
export const BARGE_IN_COOLDOWN_MS = 500

// ── Streaming STT ────────────────────────────────────────────────────────────

/**
 * Minimum audio chunk duration (ms) before sending to STT.
 * Shorter = lower latency but more requests. 1200ms is a good balance for speaches.
 */
export const STT_CHUNK_MIN_DURATION_MS = 1200

/**
 * Maximum audio chunk duration (ms). If user speaks continuously for this long,
 * force-send what we have so far.
 */
export const STT_CHUNK_MAX_DURATION_MS = 5000

/**
 * Silence duration (ms) that marks end-of-utterance within streaming mode.
 * After this much silence, flush the current chunk immediately.
 */
export const STT_SILENCE_THRESHOLD_MS = 600

/**
 * RMS threshold below which audio is considered silence for chunking purposes.
 */
export const STT_SILENCE_RMS_THRESHOLD = 0.01
