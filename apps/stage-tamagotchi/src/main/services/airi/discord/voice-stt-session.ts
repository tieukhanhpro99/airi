import { Buffer } from 'node:buffer'

const DEFAULT_INPUT_SAMPLE_RATE = 48000
const DEFAULT_INPUT_CHANNELS = 2
const DEFAULT_OUTPUT_SAMPLE_RATE = 16000
const BYTES_PER_SAMPLE = 2

export interface VoiceSttSessionResult {
  text: string
  chunks: number
  preflightChunks: number
}

export interface CreateVoiceSttSessionOptions {
  transcribe: (pcmMono16k: Buffer) => Promise<string>
  preflightChunkMs?: number
  inputSampleRate?: number
  inputChannels?: number
  outputSampleRate?: number
}

export function downsamplePcmToMono16k(
  input: Buffer,
  inputSampleRate = DEFAULT_INPUT_SAMPLE_RATE,
  inputChannels = DEFAULT_INPUT_CHANNELS,
  outputSampleRate = DEFAULT_OUTPUT_SAMPLE_RATE,
): Buffer {
  const inputFrameBytes = inputChannels * BYTES_PER_SAMPLE
  const inputFrames = Math.floor(input.length / inputFrameBytes)
  const ratio = inputSampleRate / outputSampleRate
  const outputFrames = Math.floor(inputFrames / ratio)
  const output = Buffer.alloc(outputFrames * BYTES_PER_SAMPLE)

  for (let i = 0; i < outputFrames; i++) {
    const srcOffset = Math.floor(i * ratio) * inputFrameBytes
    let mixed = 0
    for (let channel = 0; channel < inputChannels; channel++)
      mixed += input.readInt16LE(srcOffset + channel * BYTES_PER_SAMPLE)

    const mono = Math.max(-32768, Math.min(32767, Math.round(mixed / inputChannels)))
    output.writeInt16LE(mono, i * BYTES_PER_SAMPLE)
  }

  return output
}

export function createVoiceSttSession(options: CreateVoiceSttSessionOptions) {
  const inputSampleRate = options.inputSampleRate ?? DEFAULT_INPUT_SAMPLE_RATE
  const inputChannels = options.inputChannels ?? DEFAULT_INPUT_CHANNELS
  const outputSampleRate = options.outputSampleRate ?? DEFAULT_OUTPUT_SAMPLE_RATE
  const preflightChunkMs = options.preflightChunkMs ?? 5000

  const buffers: Buffer[] = []
  const transcriptTasks: Promise<string>[] = []
  let totalBytes = 0
  let preflightChunks = 0
  let finalized = false

  function bufferedMs() {
    return (totalBytes / (inputSampleRate * inputChannels * BYTES_PER_SAMPLE)) * 1000
  }

  function flush(preflight: boolean) {
    if (totalBytes === 0)
      return

    const input = Buffer.concat(buffers, totalBytes)
    buffers.length = 0
    totalBytes = 0

    if (preflight)
      preflightChunks++

    const pcmMono16k = downsamplePcmToMono16k(input, inputSampleRate, inputChannels, outputSampleRate)
    transcriptTasks.push(options.transcribe(pcmMono16k))
  }

  return {
    appendStereo48k(chunk: Buffer) {
      if (finalized)
        return

      buffers.push(chunk)
      totalBytes += chunk.length

      if (bufferedMs() >= preflightChunkMs)
        flush(true)
    },

    async finalize(): Promise<VoiceSttSessionResult> {
      if (!finalized) {
        finalized = true
        flush(false)
      }

      const text = (await Promise.all(transcriptTasks))
        .map(chunk => chunk.trim())
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()

      return {
        text,
        chunks: transcriptTasks.length,
        preflightChunks,
      }
    },
  }
}
