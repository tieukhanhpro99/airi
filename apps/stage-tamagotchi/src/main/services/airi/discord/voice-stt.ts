import type { Buffer } from 'node:buffer'

import type { DiscordVoiceSttConfig } from '@proj-airi/stage-shared'

import { pcmToWav } from './voice-audio'

/**
 * OpenAI-compatible transcription call against the user-configured STT endpoint
 * (e.g. https://github.com/speaches-ai/speaches). We call this directly with
 * `fetch` from main instead of going through `@xsai` because the renderer's
 * provider config lives behind a Pinia store we'd otherwise need to mirror in
 * main — a thin manual call keeps the surface area minimal.
 */
export async function transcribePcmMono16k(
  pcm: Buffer,
  config: DiscordVoiceSttConfig,
  signal?: AbortSignal,
): Promise<string> {
  if (!config.baseUrl)
    throw new Error('Discord voice STT: missing baseUrl')
  if (!config.model)
    throw new Error('Discord voice STT: missing model')

  const wav = pcmToWav(pcm, 16000, 1)
  const blob = new Blob([new Uint8Array(wav)], { type: 'audio/wav' })
  const form = new FormData()
  form.append('file', blob, 'voice.wav')
  form.append('model', config.model)
  form.append('response_format', config.responseFormat ?? 'text')
  if (config.language)
    form.append('language', config.language)
  if (config.prompt)
    form.append('prompt', config.prompt)

  // OpenAI shape: POST {baseUrl}/audio/transcriptions
  // Trim trailing slash so we don't end up with `//audio/...`.
  const base = config.baseUrl.replace(/\/+$/, '')
  const url = `${base}/audio/transcriptions`

  const headers: Record<string, string> = {}
  if (config.apiKey)
    headers.Authorization = `Bearer ${config.apiKey}`

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: form,
    signal,
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`STT ${res.status}: ${body.slice(0, 200)}`)
  }

  const format = config.responseFormat ?? 'text'
  if (format === 'text') {
    return (await res.text()).trim()
  }

  // json / verbose_json shape from OpenAI: { text: "..." }
  const json = await res.json() as { text?: string }
  return (json.text ?? '').trim()
}
