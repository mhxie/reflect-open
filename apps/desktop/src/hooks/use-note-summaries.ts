import { useEffect, useRef } from 'react'
import {
  cloudSummaryChoice,
  cloudSummaryConfig,
  sameSummariesModel,
  type AiProvidersState,
  type AiSummaryMode,
  type GraphInfo,
} from '@reflect/core'
import { useMainWindowEffect } from '@/hooks/use-main-window-effect.ts'
import { cloudGoAhead } from '@/hooks/use-summary-model-choice.ts'
import { pullBackup } from '@/lib/backup-pull.ts'
import {
  createNoteSummaryController,
  type NoteSummaryController,
  type NoteSummaryModels,
} from '@/lib/note-summary-controller.ts'
import { offerNoteSummaries, withdrawNoteSummariesOffer } from '@/lib/note-summary-offer.ts'
import { useSettings } from '@/providers/settings-provider.tsx'

/**
 * Runs the AI note-summary lifecycle for the open graph: long notes get a
 * one-sentence `aiSummary` that the All Notes list shows in place of their
 * opening text. Main window only — two summarizers would double-bill and race
 * the writes — and off when the `aiSummaries` setting is. Before the cloud
 * engine sends anything it asks, naming the provider and model; the go-ahead
 * records exactly those and rebuilds the controller, whose launch pass then
 * starts. A changed mode, model or provider runs a pass at once. Other devices
 * summarize too, so a pass pulls before its first model call.
 */
export function useNoteSummaries(graph: GraphInfo): void {
  const { settings, updateSettings } = useSettings()
  const enabled = settings.aiSummaries !== 'off'
  const cloudConsent = settings.aiSummariesCloudConsent
  const providers: AiProvidersState = {
    providers: settings.aiProviders,
    defaultProviderId: settings.defaultAiProviderId,
  }
  const cloudAgreed = sameSummariesModel(
    cloudConsent,
    cloudSummaryChoice(providers, settings.aiSummariesCloudModel),
  )

  // Read lazily at the start of every pass — a provider, model or mode changed
  // in Settings mid-session must be seen without rebuilding the controller.
  const modeRef = useRef<AiSummaryMode>(settings.aiSummaries)
  const providersRef = useRef<AiProvidersState>(providers)
  const modelsRef = useRef<NoteSummaryModels>({
    local: settings.aiSummariesLocalModel,
    cloud: settings.aiSummariesCloudModel,
  })
  const updateSettingsRef = useRef(updateSettings)
  const controllerRef = useRef<NoteSummaryController | null>(null)
  useEffect(() => {
    modeRef.current = settings.aiSummaries
    providersRef.current = providers
    modelsRef.current = {
      local: settings.aiSummariesLocalModel,
      cloud: settings.aiSummariesCloudModel,
    }
    updateSettingsRef.current = updateSettings
  })

  // A model chosen after a pass found none would otherwise wait for the next
  // note change or focus.
  useEffect(() => {
    controllerRef.current?.refresh()
  }, [
    settings.aiSummaries,
    settings.aiSummariesLocalModel,
    settings.aiSummariesCloudModel,
    settings.aiProviders,
    settings.defaultAiProviderId,
  ])

  // The ask outlives neither the cloud engine nor its answer.
  useEffect(() => {
    if (settings.aiSummaries !== 'cloud' || cloudAgreed) {
      withdrawNoteSummariesOffer()
    }
  }, [settings.aiSummaries, cloudAgreed])

  useMainWindowEffect(() => {
    if (!enabled) {
      return
    }
    const controller = createNoteSummaryController({
      generation: graph.generation,
      getProviders: () => providersRef.current,
      getMode: () => modeRef.current,
      getModels: () => modelsRef.current,
      cloudConsent,
      onConsentNeeded: (consent) => {
        offerNoteSummaries(consent, {
          destination: () => {
            const config = cloudSummaryConfig(providersRef.current, modelsRef.current.cloud)
            return config === null || config === 'on-device'
              ? null
              : {
                  provider: config.provider,
                  choice: { configId: config.id, modelId: config.model },
                }
          },
          start: (choice) => updateSettingsRef.current(cloudGoAhead(choice)),
        })
      },
      catchUp: pullBackup,
    })
    controllerRef.current = controller
    controller.start()
    return () => {
      controllerRef.current = null
      controller.dispose()
      withdrawNoteSummariesOffer()
    }
  }, [graph.generation, enabled, cloudConsent])
}
