import { useEffect, useMemo, useRef } from 'react'
import {
  cloudSummaryChoice,
  cloudSummaryConfig,
  sameSummariesModel,
  type AiProvidersState,
  type AiSummariesModel,
  type GraphInfo,
} from '@reflect/core'
import { cloudGoAhead } from '@/hooks/use-summary-model-choice.ts'
import { createNoteSummaryOffer } from '@/lib/note-summary-offer.ts'
import { useSettings } from '@/providers/settings-provider.tsx'
import { useAppServices, useCoreServices } from '@/services/services-provider.tsx'

/**
 * Runs the AI note-summary lifecycle for the open graph: long notes get a
 * one-sentence `aiSummary` that the All Notes list shows in place of their
 * opening text. Main window only — two summarizers would double-bill and race
 * the writes. The session follows the summary settings itself (`off` runs no
 * pass). Before the cloud engine sends anything it asks, naming the provider
 * and model; the go-ahead records exactly those.
 */
export function useNoteSummaries(graph: GraphInfo): void {
  const { noteSummaries } = useCoreServices()
  const { operations, window } = useAppServices()
  const { settings, updateSettings } = useSettings()
  const offer = useMemo(() => createNoteSummaryOffer(operations), [operations])
  const providers: AiProvidersState = {
    providers: settings.aiProviders,
    defaultProviderId: settings.defaultAiProviderId,
  }
  const cloudAgreed = sameSummariesModel(
    settings.aiSummariesCloudConsent,
    cloudSummaryChoice(providers, settings.aiSummariesCloudModel),
  )

  // Read when the user answers the ask, not when it was raised: a provider or
  // model changed in Settings meanwhile must be seen.
  const providersRef = useRef<AiProvidersState>(providers)
  const cloudModelRef = useRef<AiSummariesModel | null>(settings.aiSummariesCloudModel)
  const updateSettingsRef = useRef(updateSettings)
  useEffect(() => {
    providersRef.current = providers
    cloudModelRef.current = settings.aiSummariesCloudModel
    updateSettingsRef.current = updateSettings
  })

  // The ask outlives neither the cloud engine nor its answer.
  useEffect(() => {
    if (settings.aiSummaries !== 'cloud' || cloudAgreed) {
      offer.withdraw()
    }
  }, [settings.aiSummaries, cloudAgreed, offer])

  useEffect(() => {
    if (!window.isMainWindow()) {
      return
    }
    const session = noteSummaries.openSession({
      onConsentNeeded: (consent) => {
        offer.offer(consent, {
          destination: () => {
            const config = cloudSummaryConfig(providersRef.current, cloudModelRef.current)
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
    })
    session.start()
    return () => {
      session.dispose()
      offer.withdraw()
    }
  }, [graph.generation, noteSummaries, offer, window])
}
