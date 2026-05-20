import type { Readable as NodeReadable } from 'node:stream'

import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { PassThrough } from 'node:stream'

import ffmpegPath from 'ffmpeg-static'

// `prism-media`'s `FFmpeg` transformer is the canonical way for `@discordjs/voice` to
// transcode arbitrary audio inputs (mp3/wav/pcm) into the Opus-friendly s16le 48kHz
// stereo PCM that the voice adapter expects. We use the standalone `ffmpeg-static`
// binary directly with `child_process.spawn` so we don't pull `prism-media`'s
// transformer (which expects ffmpeg on PATH).

/** Resolve the bundled ffmpeg binary path; throws if the install couldn't fetch one. */
function resolveFfmpegPath(): string {
  // `ffmpeg-static` exposes the binary path as the default export. In ESM
  // (Electron's main process is ESM), this comes through as a string already.
  if (!ffmpegPath || typeof ffmpegPath !== 'string')
    throw new Error('ffmpeg-static failed to provide a binary path. Was the postinstall step blocked?')

  return ffmpegPath
}

export interface DecodeOptions {
  /** Output sample rate; Discord voice = 48000. */
  sampleRate?: number
  /** Output channel count; Discord voice = 2. */
  channels?: number
}

/**
 * Pipe an arbitrary container/codec buffer (mp3, wav, pcm…) through ffmpeg and
 * yield raw 16-bit signed little-endian PCM at the requested rate/channels.
 *
 * Used by the Discord voice TTS pipeline to convert provider output (typically
 * mp3) into the format `@discordjs/voice` accepts via `StreamType.Raw`.
 */
export function decodeToPcm(input: Buffer, options: DecodeOptions = {}): NodeReadable {
  const sampleRate = options.sampleRate ?? 48000
  const channels = options.channels ?? 2

  const ffmpeg = spawn(resolveFfmpegPath(), [
    '-loglevel',
    'error',
    '-i',
    'pipe:0',
    '-f',
    's16le',
    '-ar',
    String(sampleRate),
    '-ac',
    String(channels),
    'pipe:1',
  ], { stdio: ['pipe', 'pipe', 'pipe'] })

  const out = new PassThrough()

  ffmpeg.stdout.pipe(out)
  ffmpeg.stderr.on('data', (buf) => {
    // We surface ffmpeg errors but don't kill the stream — the consumer's `error`
    // handler on the resource will pick up real fatals.
    const msg = buf.toString().trim()
    if (msg)
      console.warn('[Discord/Voice/ffmpeg]', msg)
  })
  ffmpeg.on('error', (err) => {
    out.emit('error', err)
  })
  ffmpeg.on('close', (code) => {
    if (code && code !== 0)
      out.emit('error', new Error(`ffmpeg exited with code ${code}`))
  })

  // Feed the source buffer in then close stdin to signal EOF. `end()` triggers
  // ffmpeg to flush remaining samples before exiting.
  ffmpeg.stdin.on('error', (err) => {
    // Broken pipe is normal if ffmpeg already errored out; swallow to avoid noise.
    if ((err as NodeJS.ErrnoException).code !== 'EPIPE')
      console.warn('[Discord/Voice/ffmpeg/stdin]', err)
  })
  ffmpeg.stdin.end(input)

  return out
}

/**
 * Convenience: wrap raw 16kHz mono PCM (the format we ship to STT) into a WAV
 * file in memory. The legacy bot used a hand-rolled header; we keep parity for
 * compatibility with speaches/whisper.
 */
export function pcmToWav(pcm: Buffer, sampleRate = 16000, channels = 1, bitsPerSample = 16): Buffer {
  const headerSize = 44
  const dataSize = pcm.length
  const totalSize = dataSize + headerSize - 8
  const byteRate = (sampleRate * bitsPerSample * channels) / 8
  const blockAlign = (bitsPerSample * channels) / 8

  const header = Buffer.alloc(headerSize)

  header.write('RIFF', 0)
  header.writeUInt32LE(totalSize, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16) // PCM chunk size
  header.writeUInt16LE(1, 20) // PCM format
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(bitsPerSample, 34)
  header.write('data', 36)
  header.writeUInt32LE(dataSize, 40)

  return Buffer.concat([header, pcm], headerSize + dataSize)
}
