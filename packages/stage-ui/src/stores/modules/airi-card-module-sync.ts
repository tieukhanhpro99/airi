export interface AiriCardProviderSyncState {
  isProviderConfigured: (providerId: string) => boolean
  isProviderConfigDirty: (providerId: string) => boolean
}

export interface AiriCardProviderSyncOptions {
  allowSpeechNoop?: boolean
}

export function shouldSyncAiriCardProvider(
  providerId: string | undefined,
  state: AiriCardProviderSyncState,
  options: AiriCardProviderSyncOptions = {},
) {
  if (!providerId)
    return false

  if (options.allowSpeechNoop && providerId === 'speech-noop')
    return true

  return state.isProviderConfigured(providerId) || state.isProviderConfigDirty(providerId)
}
