import { describe, expect, it } from 'vitest'

import { chunkTtsInput, processNarrative } from './tts-chunker'

async function collectChunks(text: string, options?: Parameters<typeof chunkTtsInput>[1]) {
  const chunks = []
  for await (const chunk of chunkTtsInput(text, options))
    chunks.push(chunk.text)
  return chunks
}

describe('processNarrative', () => {
  it('should not strip narrative if stripNarrative is false', () => {
    const text = 'Hello [laughs] world'
    expect(processNarrative(text, { stripNarrative: false })).toBe(text)
    expect(processNarrative(text, {})).toBe(text)
  })

  it('should strip narrative if stripNarrative is true', () => {
    const text = 'Hello [laughs] world'
    expect(processNarrative(text, { stripNarrative: true })).toBe('Hello  world')
  })

  it('should keep narrative text if keepNarrativeText is true', () => {
    const text = 'Hello [laughs] world'
    expect(processNarrative(text, { stripNarrative: true, keepNarrativeText: true })).toBe('Hello laughs world')
  })

  it('should handle multiple brackets and types', () => {
    const text = 'Hi *waves* [smiling] (quietly)'
    expect(processNarrative(text, { stripNarrative: true, keepNarrativeText: false })).toBe('Hi   ')
    expect(processNarrative(text, { stripNarrative: true, keepNarrativeText: true })).toBe('Hi waves smiling quietly')
  })

  it('should handle CJK brackets', () => {
    const text = 'こんにちは（笑）【重要】'
    expect(processNarrative(text, { stripNarrative: true, keepNarrativeText: false })).toBe('こんにちは')
    expect(processNarrative(text, { stripNarrative: true, keepNarrativeText: true })).toBe('こんにちは笑重要')
  })

  it('should handle mixed bracket types with keepNarrativeText', () => {
    const text = 'Start <hidden> [box] (round) *star* End'
    expect(processNarrative(text, { stripNarrative: true, keepNarrativeText: true })).toBe('Start hidden box round star End')
  })
})

describe('chunkTtsInput', () => {
  it('can hold short sentences until enough words are buffered', async () => {
    await expect(collectChunks(
      'Hi. I am AIRI. Let us start.',
      { boost: 0, minimumWords: 8, maximumWords: 32, hardPunctuationMinWords: 8 },
    )).resolves.toEqual(['Hi. I am AIRI. Let us start.'])
  })

  it('still splits on hard punctuation after the configured minimum', async () => {
    await expect(collectChunks(
      'One two three four five six seven eight. Nine ten.',
      { boost: 0, minimumWords: 8, maximumWords: 32, hardPunctuationMinWords: 8 },
    )).resolves.toEqual(['One two three four five six seven eight.', 'Nine ten.'])
  })
})
