import { describe, expect, it } from 'vitest'

import { shouldSyncAiriCardProvider } from './airi-card-module-sync'

describe('shouldSyncAiriCardProvider', () => {
  it('rejects stale providers that were deleted or never configured', () => {
    expect(shouldSyncAiriCardProvider('modelscope', {
      isProviderConfigured: () => false,
      isProviderConfigDirty: () => false,
    })).toBe(false)
  })

  it('accepts configured or dirty providers', () => {
    expect(shouldSyncAiriCardProvider('modelscope', {
      isProviderConfigured: id => id === 'modelscope',
      isProviderConfigDirty: () => false,
    })).toBe(true)

    expect(shouldSyncAiriCardProvider('modelscope', {
      isProviderConfigured: () => false,
      isProviderConfigDirty: id => id === 'modelscope',
    })).toBe(true)
  })

  it('allows the speech noop provider when requested', () => {
    expect(shouldSyncAiriCardProvider('speech-noop', {
      isProviderConfigured: () => false,
      isProviderConfigDirty: () => false,
    }, { allowSpeechNoop: true })).toBe(true)
  })
})
