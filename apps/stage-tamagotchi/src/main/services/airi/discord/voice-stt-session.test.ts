import { Buffer } from 'node:buffer'

import { describe, expect, it } from 'vitest'

import { createVoiceSttSession } from './voice-stt-session'

function stereo48kSilence(ms: number) {
  const frames = Math.floor((48000 * ms) / 1000)
  return Buffer.alloc(frames * 2 * 2)
}

describe('createVoiceSttSession', () => {
  it('starts transcribing long chunks before finalization while keeping transcript order', async () => {
    const resolveChunk: Array<(text: string) => void> = []
    const pcmSizes: number[] = []
    const session = createVoiceSttSession({
      preflightChunkMs: 5000,
      transcribe: async (pcm) => {
        pcmSizes.push(pcm.length)
        return new Promise<string>(resolve => resolveChunk.push(resolve))
      },
    })

    session.appendStereo48k(stereo48kSilence(5000))

    expect(pcmSizes).toEqual([16000 * 5 * 2])

    session.appendStereo48k(stereo48kSilence(2000))
    const result = session.finalize()

    expect(pcmSizes).toEqual([16000 * 5 * 2, 16000 * 2 * 2])

    resolveChunk[1]('second')
    resolveChunk[0]('first')

    await expect(result).resolves.toEqual({
      text: 'first second',
      chunks: 2,
      preflightChunks: 1,
    })
  })

  it('keeps short utterances as a single final transcription', async () => {
    const pcmSizes: number[] = []
    const session = createVoiceSttSession({
      preflightChunkMs: 5000,
      transcribe: async (pcm) => {
        pcmSizes.push(pcm.length)
        return 'short'
      },
    })

    session.appendStereo48k(stereo48kSilence(4000))
    expect(pcmSizes).toEqual([])

    await expect(session.finalize()).resolves.toEqual({
      text: 'short',
      chunks: 1,
      preflightChunks: 0,
    })
    expect(pcmSizes).toEqual([16000 * 4 * 2])
  })
})
