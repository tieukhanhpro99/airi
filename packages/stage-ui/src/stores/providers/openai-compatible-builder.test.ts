import { describe, expect, it } from 'vitest'

import { pickSpeechRequestOptions } from './openai-compatible-builder'

describe('pickSpeechRequestOptions', () => {
  it('keeps speech payload options and drops provider infrastructure config', () => {
    expect(pickSpeechRequestOptions({
      apiKey: 'sk-test',
      baseUrl: 'http://localhost:8100/v1',
      baseURL: 'http://localhost:8100/v1',
      model: 'omnivoice',
      voice: 'clone:neurosama',
      speed: 1.1,
      responseFormat: 'wav',
      language: 'en',
      numSteps: 32,
      guidanceScale: 3,
      positionTemperature: 1,
      preprocessPrompt: false,
      denoise: true,
      ignored: 'nope',
    })).toEqual({
      speed: 1.1,
      responseFormat: 'wav',
      language: 'en',
      numSteps: 32,
      guidanceScale: 3,
      positionTemperature: 1,
      preprocessPrompt: false,
      denoise: true,
    })
  })
})
