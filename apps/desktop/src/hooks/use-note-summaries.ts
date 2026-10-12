import { useEffect, useRef } from 'react'
import {
  cloudSummaryConfig,
  type AiProvidersState,
  type AiSummaryMode,
  type GraphInfo,
} from '@reflect/core'
import { useMainWindowEffect } from '@/hooks/use-main-window-effect.ts'
import {
  createNoteSummaryController,
  type NoteSummaryModels,
} from '@/lib/note-summary-controller.ts'
import { offerNoteSummaries, withdrawNoteSummariesOffer } from '@/lib/note-summary-offer.ts'
import { useSettings } from '@/providers/settings-provider.tsx'

/**
 * Runs the AI note-summary lifecycle for the open graph: long notes get a
 * one-sentence `aiSummary` that the All Notes list shows in place of their
 * opening text. Main window only — two summarizers would double-bill and race
 * the writes — and off when the `aiSummaries` setting is. Before the cloud
 * engine sends anything it asks once, naming the model; the go-ahead pins
 * that model and rebuilds the controller, whose launch pass then starts.
 */
export function useNoteSummaries(graph: GraphInfo): void {
  const { settings, updateSettings } = useSettings()
  const enabled = settings.aiSummaries !== 'off'
  // A go-ahead counts only for the model it pinned.
  const cloudAgreed = settings.aiSummariesCloudConfirmed && settings.aiSummariesCloudModel !== null

  // Read lazily at the start of every pass — a provider, model or mode changed
  // in Settings mid-session must be seen without rebuilding the controller.
  const modeRef = useRef<AiSummaryMode>(settings.aiSummaries)
  const providersRef = useRef<AiProvidersState>({
    providers: settings.aiProviders,
    defaultProviderId: settings.defaultAiProviderId,
  })
  const modelsRef = useRef<NoteSummaryModels>({
    local: settings.aiSummariesLocalModel,
    cloud: settings.aiSummariesCloudModel,
  })
  const updateSettingsRef = useRef(updateSettings)
  useEffect(() => {
    modeRef.current = settings.aiSummaries
    providersRef.current = {
      providers: settings.aiProviders,
      defaultProviderId: settings.defaultAiProviderId,
    }
    modelsRef.current = {
      local: settings.aiSummariesLocalModel,
      cloud: settings.aiSummariesCloudModel,
    }
    updateSettingsRef.current = updateSettings
  })

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
      cloudConfirmed: cloudAgreed,
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
          start: (choice) =>
            updateSettingsRef.current({
              aiSummariesCloudModel: choice,
              aiSummariesCloudConfirmed: true,
            }),
        })
      },
    })
    controller.start()
    return () => {
      controller.dispose()
      withdrawNoteSummariesOffer()
    }
  }, [graph.generation, enabled, cloudAgreed])
}
