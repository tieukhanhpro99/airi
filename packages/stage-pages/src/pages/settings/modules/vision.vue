<script setup lang="ts">
import { Alert, ErrorContainer, RadioCardManySelect, RadioCardSimple } from '@proj-airi/stage-ui/components'
import { useAnalytics } from '@proj-airi/stage-ui/composables'
import { useVisionStore } from '@proj-airi/stage-ui/stores/modules/vision'
import { useProvidersStore } from '@proj-airi/stage-ui/stores/providers'
import { storeToRefs } from 'pinia'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { toast } from 'vue-sonner'

const providersStore = useProvidersStore()
const visionStore = useVisionStore()
const { persistedVisionProvidersMetadata, configuredProviders } = storeToRefs(providersStore)
const {
  activeProvider,
  activeModel,
  supportsModelListing,
  providerModels,
  isLoadingActiveProviderModels,
  activeProviderModelError,
} = storeToRefs(visionStore)

const currentStrategy = ref('direct')
const customModelName = ref('')
const modelSearchQuery = ref('')

const filteredModels = computed(() => {
  // Bypass strict modality filtering for local/BYOM providers as they often lack metadata
  if (['lm-studio', 'ollama', 'openai-compatible'].includes(activeProvider.value)) {
    return providerModels.value
  }
  const models = providerModels.value.filter((model: any) => model.capabilities?.includes('vision'))
  if (typeof localStorage !== 'undefined' && localStorage.getItem('airi:debug') === '1') {
    console.log(`[Vision UI] Provider Models: ${providerModels.value.length}, Filtered Models: ${models.length}`)
  }
  return models
})

watch(providerModels, (models) => {
  if (typeof localStorage !== 'undefined' && localStorage.getItem('airi:debug') === '1') {
    console.log('[Vision UI] providerModels updated:', models)
  }
}, { deep: true })

const { t } = useI18n()
const { trackProviderClick } = useAnalytics()
const isOpenAICompatibleProvider = computed(() => activeProvider.value === 'openai-compatible')

watch(activeProvider, async (provider, oldProvider) => {
  if (!provider)
    return

  // Reset model when switching providers (but not on initial load)
  if (oldProvider !== undefined && oldProvider !== provider) {
    activeModel.value = ''
  }

  await visionStore.loadModelsForProvider(provider)
}, { immediate: true })

// Feedback when model is set
watch(activeModel, (newModel, oldModel) => {
  if (newModel && oldModel !== undefined && newModel !== oldModel) {
    toast.success(`Vision model updated to: ${newModel}`)
  }
})

function updateCustomModelName(value: string) {
  customModelName.value = value
}

function handleDeleteProvider(providerId: string) {
  if (activeProvider.value === providerId) {
    activeProvider.value = ''
    activeModel.value = ''
  }
  providersStore.deleteProvider(providerId)
}

// ── Source picker state ────────────────────────────────────────────────────
const newBlacklistEntry = ref('')
function addBlacklistEntry() {
  if (!newBlacklistEntry.value.trim())
    return
  visionStore.addToBlacklist(newBlacklistEntry.value)
  newBlacklistEntry.value = ''
}

const pauseRemainingMinutes = computed(() => {
  if (!visionStore.isPaused)
    return 0
  return Math.max(0, Math.ceil((visionStore.pausedUntil - Date.now()) / 60_000))
})
</script>

<template>
  <div bg="neutral-50 dark:[rgba(0,0,0,0.3)]" rounded-xl p-4 flex="~ col gap-4">
    <!-- ── Master Switch (always at the top so it's reachable in 1 glance) ─── -->
    <div
      :class="[
        'rounded-xl p-4 flex items-center justify-between gap-4 border-2',
        visionStore.visionMasterEnabled
          ? 'border-primary-500/40 bg-primary-500/5'
          : 'border-amber-500/40 bg-amber-500/5',
      ]"
    >
      <div class="flex items-center gap-3">
        <div
          :class="[
            'text-3xl',
            visionStore.visionMasterEnabled ? 'i-solar:eye-bold-duotone text-primary-500' : 'i-solar:eye-closed-bold-duotone text-amber-500',
          ]"
        />
        <div class="flex flex-col">
          <span class="font-bold">Vision Master Switch</span>
          <span class="text-xs text-neutral-500">
            <template v-if="visionStore.visionMasterEnabled">
              Vision đang bật. <code>/look</code>, hotkey và auto-modes (nếu cấu hình) đều hoạt động.
            </template>
            <template v-else>
              Vision đang tắt. Mọi capture đều bị chặn cho tới khi bật lại.
            </template>
          </span>
        </div>
      </div>
      <button
        type="button"
        :class="[
          'relative inline-flex h-7 w-12 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out',
          visionStore.visionMasterEnabled ? 'bg-primary-500' : 'bg-neutral-300 dark:bg-neutral-700',
        ]"
        @click="visionStore.setMasterEnabled(!visionStore.visionMasterEnabled)"
      >
        <span
          aria-hidden="true"
          :class="[
            'pointer-events-none inline-block h-6 w-6 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out',
            visionStore.visionMasterEnabled ? 'translate-x-5' : 'translate-x-0',
          ]"
        />
      </button>
    </div>

    <div>
      <div flex="~ col gap-4">
        <div>
          <div flex="~ row items-center justify-between gap-2">
            <h2 class="text-lg text-neutral-500 md:text-2xl dark:text-neutral-500">
              Vision Provider
            </h2>
            <div
              v-if="visionStore.configured"
              class="flex items-center gap-1.5 rounded-full bg-green-100 px-2.5 py-0.5 text-xs text-green-700 font-bold dark:bg-green-900/30 dark:text-green-400"
            >
              <div i-solar:check-circle-bold class="text-sm" />
              <span>Configured</span>
            </div>
            <div
              v-else
              class="flex items-center gap-1.5 rounded-full bg-neutral-200 px-2.5 py-0.5 text-xs text-neutral-500 font-bold dark:bg-neutral-800 dark:text-neutral-500"
            >
              <div i-solar:info-circle-bold class="text-sm" />
              <span>Not Configured</span>
            </div>
          </div>
          <div text="neutral-400 dark:neutral-400">
            <span>Select the AI provider and model you want to use for visual analysis and image processing.</span>
          </div>
        </div>
        <div max-w-full>
          <fieldset
            v-if="persistedVisionProvidersMetadata.length > 0"
            flex="~ col gap-2"
            class="max-h-[300px] overflow-y-auto pr-2" min-w-0
            role="radiogroup"
          >
            <RadioCardSimple
              v-for="metadata in persistedVisionProvidersMetadata"
              :id="metadata.id"
              :key="metadata.id"
              v-model="activeProvider"
              name="provider"
              :value="metadata.id"
              :title="metadata.name || 'Unknown'"
              :description="metadata.description"
              @click="trackProviderClick(metadata.id, 'vision')"
            >
              <template #topRight>
                <button
                  type="button"
                  class="rounded bg-neutral-100 p-1 text-neutral-600 transition-colors dark:bg-neutral-800/60 hover:bg-neutral-200 dark:text-neutral-300 dark:hover:bg-neutral-700/60"
                  @click.stop.prevent="handleDeleteProvider(metadata.id)"
                >
                  <div i-solar:trash-bin-trash-bold-duotone class="text-base" />
                </button>
              </template>

              <template v-if="configuredProviders[metadata.id] === false" #bottomRight>
                <div class="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-700 font-medium dark:bg-amber-900/30 dark:text-amber-300">
                  {{ t('settings.pages.modules.consciousness.sections.section.provider-model-selection.health_check_failed') }}
                </div>
              </template>
            </RadioCardSimple>
            <RouterLink
              to="/settings/providers"
              border="2px dashed"
              class="border-neutral-200 bg-transparent text-neutral-400 dark:border-neutral-800 hover:border-primary-500/50 hover:bg-neutral-50 hover:text-primary-500 dark:hover:border-primary-400/50 dark:hover:bg-neutral-900/50 dark:hover:text-primary-400"
              flex="~ row items-center justify-center gap-2"
              transition="all duration-200 ease-in-out"
              relative w-full shrink-0 rounded-xl p-3
            >
              <div i-solar:add-circle-line-duotone class="text-xl" />
              <span class="text-sm font-medium">Add Provider</span>
            </RouterLink>
          </fieldset>
          <div v-else>
            <RouterLink
              class="flex items-center gap-3 rounded-lg p-4"
              border="2 dashed neutral-200 dark:neutral-800"
              bg="neutral-50 dark:neutral-800"
              transition="colors duration-200 ease-in-out"
              to="/settings/providers"
            >
              <div i-solar:warning-circle-line-duotone class="text-2xl text-amber-500 dark:text-amber-400" />
              <div class="flex flex-col">
                <span class="font-medium">No Vision Providers Configured</span>
                <span class="text-sm text-neutral-400 dark:text-neutral-500">Go to Settings > Providers to set up a provider for vision tasks. Setup OpenAI or OpenRouter.</span>
              </div>
              <div i-solar:arrow-right-line-duotone class="ml-auto text-xl text-neutral-400 dark:text-neutral-500" />
            </RouterLink>
          </div>
        </div>
      </div>
    </div>

    <!-- Model selection section -->
    <div v-if="activeProvider && supportsModelListing">
      <div flex="~ col gap-4">
        <div>
          <h2 class="text-lg md:text-2xl">
            Vision Model
          </h2>
          <div class="flex flex-col items-start gap-1 text-neutral-400 md:flex-row md:items-center md:justify-between dark:text-neutral-400">
            <span>Select the model architecture.</span>
            <div class="flex items-center gap-2 text-sm font-medium">
              <span class="text-neutral-400 dark:text-neutral-400">Current Model:</span>
              <span v-if="activeModel" class="text-primary-500 dark:text-primary-400">{{ activeModel }}</span>
              <span v-else class="text-neutral-400/50 italic">Not Set</span>
            </div>
          </div>
        </div>

        <div v-if="isLoadingActiveProviderModels" class="flex items-center justify-center py-4">
          <div class="mr-2 animate-spin">
            <div i-solar:spinner-line-duotone text-xl />
          </div>
          <span>Loading models...</span>
        </div>

        <template v-else-if="activeProviderModelError">
          <ErrorContainer
            title="Failed to fetch models"
            :error="activeProviderModelError"
          />

          <div v-if="isOpenAICompatibleProvider" class="mt-2">
            <label class="mb-1 block text-sm font-medium">
              Model ID (Manual)
            </label>
            <input
              v-model="activeModel"
              type="text"
              class="w-full border border-neutral-300 rounded bg-white px-3 py-2 dark:border-neutral-700 dark:bg-neutral-900"
              placeholder="e.g. gpt-4o-mini"
            >
          </div>
        </template>

        <div v-if="activeProviderModelError" class="mt-2">
          <label class="mb-1 block text-sm font-medium">
            Model ID (Manual)
          </label>
          <input
            v-model="activeModel" type="text"
            class="w-full border border-neutral-300 rounded bg-white px-3 py-2 dark:border-neutral-700 dark:bg-neutral-900"
            placeholder="e.g. gpt-4o-mini"
          >
        </div>

        <template v-else-if="providerModels.length === 0 && !isLoadingActiveProviderModels">
          <Alert type="warning">
            <template #title>
              No models found
            </template>
            <template #content>
              We couldn't retrieve any available models from the provider. You might need to specify the model name manually if you're using a custom endpoint.
            </template>
          </Alert>

          <div v-if="isOpenAICompatibleProvider" class="mt-2">
            <label class="mb-1 block text-sm font-medium">
              Model ID (Manual)
            </label>
            <input
              v-model="activeModel"
              type="text"
              class="w-full border border-neutral-300 rounded bg-white px-3 py-2 dark:border-neutral-700 dark:bg-neutral-900"
              placeholder="e.g. gpt-4o-mini"
            >
          </div>
        </template>

        <template v-else-if="providerModels.length > 0">
          <RadioCardManySelect
            v-model="activeModel"
            v-model:search-query="modelSearchQuery"
            :items="filteredModels"
            :searchable="true"
            :allow-custom="true"
            search-placeholder="Search models..."
            search-no-results-title="No results found"
            search-no-results-description="Could not find any matching models"
            search-results-text="Found {count} out of {total} models"
            custom-input-placeholder="Type custom model ID..."
            expand-button-text="Show more"
            collapse-button-text="Show less"
            @update:custom-value="updateCustomModelName"
          />
        </template>
      </div>
    </div>

    <!-- Provider doesn't support model listing -->
    <div v-else-if="activeProvider && !supportsModelListing">
      <div flex="~ col gap-4">
        <div>
          <h2 class="text-lg text-neutral-500 md:text-2xl dark:text-neutral-400">
            Vision Model
          </h2>
          <div text="neutral-400 dark:neutral-500">
            <span>Select the model architecture.</span>
          </div>
        </div>

        <div
          class="flex items-center gap-3 border border-primary-200 rounded-lg bg-primary-50 p-4 dark:border-primary-800 dark:bg-primary-900/20"
        >
          <div i-solar:info-circle-line-duotone class="text-2xl text-primary-500 dark:text-primary-400" />
          <div class="flex flex-col">
            <span class="font-medium">Model listing not supported</span>
            <span class="text-sm text-primary-600 dark:text-primary-400">This provider does not support retrieving a list of available models. Please enter the exact model ID manually.</span>
          </div>
        </div>

        <div class="mt-2">
          <label class="mb-1 block text-sm font-medium">
            Model ID (Manual)
          </label>
          <input
            v-model="activeModel" type="text"
            class="w-full border border-neutral-300 rounded bg-white px-3 py-2 dark:border-neutral-700 dark:bg-neutral-900"
            placeholder="e.g. gpt-4o-mini"
          >
        </div>
      </div>
    </div>

    <!-- Mock Strategy Section -->
    <div v-if="activeProvider && activeModel">
      <div flex="~ col gap-4">
        <div>
          <h2 class="text-lg text-neutral-500 md:text-2xl dark:text-neutral-500">
            Image Description
          </h2>
          <div text="neutral-400 dark:neutral-400">
            <span>What should the model do with the description of the image provided?</span>
          </div>
        </div>

        <div flex="~ col gap-2" class="max-h-[300px] overflow-y-auto pr-2" max-w-full pb-2>
          <RadioCardSimple
            id="strategy-direct"
            v-model="currentStrategy"
            name="strategy"
            value="direct"
            title="Direct Response"
            description="Allow this vision model to reply to the image"
            class="min-w-60"
          />
          <RadioCardSimple
            id="strategy-forward"
            v-model="currentStrategy"
            name="strategy"
            value="forward"
            title="Forward to LLM"
            description="Forward the description of the image to your consciousness model"
            class="min-w-65"
            :disabled="true"
          >
            <template #title>
              <div flex="~ row items-center gap-2">
                <span>Forward to LLM</span>
                <span class="rounded bg-neutral-200 px-1.5 py-0.5 text-[10px] text-neutral-500 font-bold tracking-wider uppercase dark:bg-neutral-800 dark:text-neutral-400">
                  Planned
                </span>
              </div>
            </template>
          </RadioCardSimple>
        </div>
      </div>
    </div>

    <!-- Prompt Shim Section -->
    <div v-if="activeProvider && activeModel">
      <div flex="~ col gap-4">
        <div>
          <h2 class="text-lg text-neutral-500 md:text-2xl dark:text-neutral-500">
            Vision Directives
          </h2>
          <div text="neutral-400 dark:neutral-400">
            <span>Hidden instructions sent alongside images to guide the vision model's behavior and personality.</span>
          </div>
        </div>

        <div class="space-y-2">
          <textarea
            v-model="visionStore.promptShim"
            class="min-h-24 w-full border border-neutral-300 rounded-lg bg-white p-3 text-sm dark:border-neutral-700 dark:bg-neutral-900/50"
            placeholder="Enter hidden vision directives..."
          />
          <div class="flex justify-end">
            <button
              class="text-xs text-neutral-400 transition-colors hover:text-primary-500"
              @click="visionStore.promptShim = 'You are currently acting as a vision-capable stand-in for the main character. Keep your responses natural, in-character, and avoid any meta-commentary about \'analyzing\' or \'describing\' the image for the user. Just react to what you see as the character would.'"
            >
              Reset to default
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- ── Source Picker (multi-screen / multi-window) ─────────────────────── -->
    <div v-if="activeProvider && activeModel">
      <div flex="~ col gap-4">
        <div>
          <div flex="~ row items-center justify-between gap-2">
            <h2 class="text-lg text-neutral-500 md:text-2xl dark:text-neutral-500">
              Capture Sources
            </h2>
            <button
              type="button"
              class="rounded bg-neutral-100 px-2 py-1 text-xs text-neutral-600 transition-colors dark:bg-neutral-800/60 hover:bg-neutral-200 dark:text-neutral-300 dark:hover:bg-neutral-700/60"
              :disabled="visionStore.isLoadingSources"
              @click="visionStore.refreshSources()"
            >
              <span v-if="visionStore.isLoadingSources">Loading…</span>
              <span v-else>Refresh</span>
            </button>
          </div>
        <div text="neutral-400 dark:neutral-400">
          <span>How should AIRI decide which screen(s) to capture?</span>
        </div>
      </div>

      <!-- Source-mode radio: Predict / All / Specific. Mutually exclusive. -->
      <div class="grid grid-cols-1 gap-2 md:grid-cols-3">
        <label
          :class="[
            'flex cursor-pointer items-start gap-2 rounded-lg border-2 p-3 transition-all',
            visionStore.predictMode
              ? 'border-primary-500 bg-primary-500/10'
              : 'border-neutral-200 dark:border-neutral-700',
          ]"
        >
          <input
            type="radio"
            :checked="visionStore.predictMode"
            class="mt-1 h-4 w-4 border-gray-300 text-primary-600"
            @change="visionStore.predictMode = true; visionStore.captureAllScreens = false"
          >
          <div class="flex flex-col">
            <span class="text-sm font-medium">🎯 Predict (auto)</span>
            <span class="text-xs text-neutral-500">Tự pick màn hình bạn đang dùng (theo cửa sổ active, fallback chuột). Khuyến nghị cho multi-monitor.</span>
          </div>
        </label>

        <label
          :class="[
            'flex cursor-pointer items-start gap-2 rounded-lg border-2 p-3 transition-all',
            !visionStore.predictMode && visionStore.captureAllScreens
              ? 'border-primary-500 bg-primary-500/10'
              : 'border-neutral-200 dark:border-neutral-700',
          ]"
        >
          <input
            type="radio"
            :checked="!visionStore.predictMode && visionStore.captureAllScreens"
            class="mt-1 h-4 w-4 border-gray-300 text-primary-600"
            @change="visionStore.predictMode = false; visionStore.captureAllScreens = true"
          >
          <div class="flex flex-col">
            <span class="text-sm font-medium">🖥️ All monitors</span>
            <span class="text-xs text-neutral-500">Capture mọi màn hình mỗi lần. Tốn token nhất nhưng AIRI thấy hết.</span>
          </div>
        </label>

        <label
          :class="[
            'flex cursor-pointer items-start gap-2 rounded-lg border-2 p-3 transition-all',
            !visionStore.predictMode && !visionStore.captureAllScreens
              ? 'border-primary-500 bg-primary-500/10'
              : 'border-neutral-200 dark:border-neutral-700',
          ]"
        >
          <input
            type="radio"
            :checked="!visionStore.predictMode && !visionStore.captureAllScreens"
            class="mt-1 h-4 w-4 border-gray-300 text-primary-600"
            @change="visionStore.predictMode = false; visionStore.captureAllScreens = false"
          >
          <div class="flex flex-col">
            <span class="text-sm font-medium">📌 Specific sources</span>
            <span class="text-xs text-neutral-500">Pick chính xác monitor/cửa sổ bên dưới. Predict + All bị bỏ qua.</span>
          </div>
        </label>
      </div>

      <!-- Specific source picker: only meaningful when "Specific sources" mode is active. -->
      <div v-if="!visionStore.predictMode && !visionStore.captureAllScreens" flex="~ col gap-3">
        <div v-if="visionStore.availableSources.length === 0" class="text-sm text-neutral-500 italic">
          No sources enumerated yet. Click <strong>Refresh</strong> to scan your displays and windows.
        </div>

        <div v-else class="grid grid-cols-2 gap-3 lg:grid-cols-3">
          <button
            v-for="source in visionStore.availableSources"
            :key="source.id"
            type="button"
            :class="[
              'relative flex flex-col gap-2 rounded-xl border-2 p-2 text-left transition-all',
              visionStore.selectedSourceIds.includes(source.id)
                ? 'border-primary-500 bg-primary-500/10'
                : 'border-neutral-200 bg-white hover:border-primary-300 dark:border-neutral-700 dark:bg-neutral-800',
            ]"
            @click="visionStore.toggleSourceSelection(source.id)"
          >
            <img
              v-if="source.thumbnailDataUrl"
              :src="source.thumbnailDataUrl"
              :alt="source.name"
              class="aspect-video w-full rounded object-cover"
            >
            <div
              v-else
              class="aspect-video w-full flex items-center justify-center rounded bg-neutral-200 dark:bg-neutral-700"
            >
              <div i-solar:gallery-bold-duotone class="text-3xl text-neutral-400" />
            </div>
            <div class="flex items-center gap-1">
              <div
                :class="[
                  'shrink-0 text-base',
                  source.type === 'screen' ? 'i-solar:monitor-bold-duotone' : 'i-solar:window-frame-bold-duotone',
                ]"
              />
              <span class="truncate text-xs font-medium">{{ source.name }}</span>
            </div>
          </button>
        </div>
      </div>
    </div>

    <!-- ── Operation Modes ──────────────────────────────────────────────────── -->
    <div v-if="activeProvider && activeModel">
      <div flex="~ col gap-4">
        <div>
          <h2 class="text-lg text-neutral-500 md:text-2xl dark:text-neutral-500">
            Operation Modes
          </h2>
          <div text="neutral-400 dark:neutral-400">
            <span>All modes here are <strong>gated by the Master Switch</strong> at the top. <code>/look</code> works whenever the master is on; the toggles below control AI's <em>automatic</em> capture behavior.</span>
          </div>
        </div>

        <label class="flex cursor-pointer items-start gap-3 border border-neutral-200 rounded-lg p-3 dark:border-neutral-700">
          <input v-model="visionStore.isWitnessEnabled" type="checkbox" class="mt-0.5 h-4 w-4 border-gray-300 rounded text-primary-600">
          <div class="flex flex-col">
            <span class="font-medium">Master Switch (Witness)</span>
            <span class="text-xs text-neutral-500">Required to enable any automatic capture below. Off = on-demand only.</span>
          </div>
        </label>

        <label
          :class="[
            'flex cursor-pointer items-start gap-3 rounded-lg border border-neutral-200 p-3 dark:border-neutral-700',
            !visionStore.isWitnessEnabled && 'pointer-events-none opacity-50',
          ]"
        >
          <input v-model="visionStore.smartEnabled" type="checkbox" class="mt-0.5 h-4 w-4 border-gray-300 rounded text-primary-600">
          <div class="flex flex-col gap-1">
            <span class="font-medium">Smart Mode (Active Window Trigger)</span>
            <span class="text-xs text-neutral-500">Capture when you switch to a different application — debounced + cooldown so it doesn't fire on every alt-tab.</span>
            <div v-if="visionStore.smartEnabled" class="mt-2 flex flex-col gap-2 text-xs">
              <div class="flex flex-wrap gap-3">
                <label class="flex items-center gap-1">
                  Granularity
                  <select
                    v-model="visionStore.smartGranularity"
                    class="rounded border border-neutral-300 bg-transparent px-1 py-0.5 text-xs dark:border-neutral-600"
                  >
                    <option value="process">App-only (recommended)</option>
                    <option value="title">App + Title (sensitive)</option>
                  </select>
                </label>
                <label class="flex items-center gap-1">
                  Debounce (ms)
                  <input
                    v-model.number="visionStore.smartDebounceMs"
                    type="number" min="500" step="500"
                    class="w-20 border border-neutral-300 rounded bg-transparent px-1 py-0.5 dark:border-neutral-600"
                  >
                </label>
                <label class="flex items-center gap-1">
                  Cooldown (ms)
                  <input
                    v-model.number="visionStore.smartCooldownMs"
                    type="number" min="5000" step="5000"
                    class="w-24 border border-neutral-300 rounded bg-transparent px-1 py-0.5 dark:border-neutral-600"
                  >
                </label>
              </div>
              <div class="flex flex-col gap-1">
                <span class="text-neutral-500">Apps to ignore as smart-mode destinations:</span>
                <div class="flex flex-wrap gap-1">
                  <span
                    v-for="entry in visionStore.smartIgnoreApps"
                    :key="entry"
                    class="flex items-center gap-1 border border-neutral-200 rounded-full bg-neutral-100 px-2 py-0.5 dark:border-neutral-700 dark:bg-neutral-800"
                  >
                    <span>{{ entry }}</span>
                    <button
                      type="button"
                      class="text-neutral-400 hover:text-red-500"
                      @click="visionStore.smartIgnoreApps = visionStore.smartIgnoreApps.filter((e: string) => e !== entry)"
                    >
                      <div i-solar:close-circle-bold-duotone />
                    </button>
                  </span>
                </div>
              </div>
              <p class="text-[10px] text-neutral-400">
                Tip: cooldown 180000ms = 3 phút. Granularity "App-only" coi việc đổi tab/file trong cùng app là bình thường, không trigger.
              </p>
            </div>
          </div>
        </label>

        <label
          :class="[
            'flex cursor-pointer items-start gap-3 rounded-lg border border-neutral-200 p-3 dark:border-neutral-700',
            !visionStore.isWitnessEnabled && 'pointer-events-none opacity-50',
          ]"
        >
          <input v-model="visionStore.periodicEnabled" type="checkbox" class="mt-0.5 h-4 w-4 border-gray-300 rounded text-primary-600">
          <div class="flex flex-col gap-1">
            <span class="font-medium">Periodic Mode (Interval)</span>
            <span class="text-xs text-neutral-500">Capture at a fixed interval regardless of activity. Costs tokens consistently.</span>
            <div v-if="visionStore.periodicEnabled" class="mt-2 flex items-center gap-2 text-xs">
              <span>Every</span>
              <input
                v-model.number="visionStore.periodicIntervalMinutes"
                type="number" min="1" max="120"
                class="w-16 border border-neutral-300 rounded bg-transparent px-1 py-0.5 dark:border-neutral-600"
              >
              <span>minutes</span>
            </div>
          </div>
        </label>

        <div class="rounded-lg bg-neutral-50 p-3 text-xs text-neutral-600 dark:bg-neutral-800/40 dark:text-neutral-400">
          <div class="mb-1 flex items-center gap-1 text-neutral-700 font-semibold dark:text-neutral-300">
            <div i-solar:keyboard-bold-duotone /> Hotkeys (global)
          </div>
          <div><kbd class="rounded bg-neutral-200 px-1 dark:bg-neutral-700">Ctrl+Shift+V</kbd> — capture now (on-demand)</div>
          <div><kbd class="rounded bg-neutral-200 px-1 dark:bg-neutral-700">Ctrl+Shift+P</kbd> — toggle 15-min pause</div>
        </div>
      </div>
    </div>

    <!-- ── Privacy & Pause ──────────────────────────────────────────────────── -->
    <div v-if="activeProvider && activeModel">
      <div flex="~ col gap-4">
        <div>
          <h2 class="text-lg text-neutral-500 md:text-2xl dark:text-neutral-500">
            Privacy
          </h2>
          <div text="neutral-400 dark:neutral-400">
            <span>Block specific apps from being captured, or pause vision entirely.</span>
          </div>
        </div>

        <div
          :class="[
            'rounded-lg p-3 flex items-center justify-between',
            visionStore.isPaused
              ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-800 dark:text-amber-300'
              : 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400',
          ]"
        >
          <div class="flex items-center gap-2 text-sm font-medium">
            <div :class="visionStore.isPaused ? 'i-solar:eye-closed-bold-duotone' : 'i-solar:eye-bold-duotone'" />
            <span v-if="visionStore.isPaused">Paused — about {{ pauseRemainingMinutes }} min remaining</span>
            <span v-else>Vision active</span>
          </div>
          <div class="flex items-center gap-2">
            <button
              v-if="visionStore.isPaused"
              type="button"
              class="rounded bg-white px-2 py-1 text-xs text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
              @click="visionStore.resumeNow()"
            >
              Resume now
            </button>
            <template v-else>
              <button
                v-for="m in [15, 30, 60]"
                :key="m"
                type="button"
                class="rounded bg-white px-2 py-1 text-xs text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
                @click="visionStore.pauseFor(m)"
              >
                Pause {{ m }}m
              </button>
            </template>
          </div>
        </div>

        <div class="space-y-2">
          <label class="text-sm font-medium">App Blacklist</label>
          <p class="text-xs text-neutral-500">
            Substring match (case-insensitive) against active window title or process name. If matched, capture is skipped.
          </p>
          <div class="flex gap-2">
            <input
              v-model="newBlacklistEntry"
              type="text"
              placeholder="e.g. 1password, banking, vault"
              class="flex-1 border border-neutral-300 rounded bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
              @keydown.enter="addBlacklistEntry"
            >
            <button
              type="button"
              class="rounded bg-primary-500 px-3 py-2 text-sm text-white hover:bg-primary-600"
              @click="addBlacklistEntry"
            >
              Add
            </button>
          </div>
          <div v-if="visionStore.appBlacklist.length > 0" class="flex flex-wrap gap-2">
            <span
              v-for="entry in visionStore.appBlacklist"
              :key="entry"
              class="flex items-center gap-1 border border-neutral-200 rounded-full bg-neutral-100 px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-800"
            >
              <span>{{ entry }}</span>
              <button
                type="button"
                class="text-neutral-400 hover:text-red-500"
                @click="visionStore.removeFromBlacklist(entry)"
              >
                <div i-solar:close-circle-bold-duotone />
              </button>
            </span>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div
    v-motion
    text="neutral-200/50 dark:neutral-600/20" pointer-events-none
    fixed top="[calc(100dvh-15rem)]" bottom-0 right--5 z--1
    :initial="{ scale: 0.9, opacity: 0, x: 20 }"
    :enter="{ scale: 1, opacity: 1, x: 0 }"
    :duration="500"
    size-60
    flex items-center justify-center
  >
    <div text="60" i-solar:eye-scan-bold-duotone />
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: settings.pages.modules.vision.title
  subtitleKey: settings.title
  stageTransition:
    name: slide
</route>
