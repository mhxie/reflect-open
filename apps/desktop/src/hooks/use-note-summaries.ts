import { useEffect, useRef } from 'react'
import {
  cloudSummaryConfig,
  type AiProvidersState,
  type AiSummaryMode,
  type GraphInfo,
} from '@reflect/core'
import { useMainWindowEffect } from '@/hooks/use-main-window-effect.ts'
import { createNoteSummaryController } from '@/lib/note-summary-controller.ts'
import { offerNoteSummaries, withdrawNoteSummariesOffer } from '@/lib/note-summary-offer.ts'
import { useSettings } from '@/providers/settings-provider.tsx'

/**
 * Runs the AI note-summary lifecycle for the open graph: long notes get a
 * one-sentence `aiSummary` that the All Notes list shows in place of their
 * opening text. Main window only — two summarizers would double-bill and race
 * the writes — and off when the `aiSummaries` setting is. Before the cloud
 * engine sends anything it asks once; the go-ahead rebuilds the controller,
 * whose launch pass then starts.
 */
export function useNoteSummaries(graph: GraphInfo): void {
  const { settings, updateSettings } = useSettings()
  const enabled = settings.aiSummaries !== 'off'
  const cloudConfirmed = settings.aiSummariesCloudConfirmed

  // Read lazily at the start of every pass — a provider or mode changed in
  // Settings mid-session must be seen without rebuilding the controller.
  const modeRef = useRef<AiSummaryMode>(settings.aiSummaries)
  const providersRef = useRef<AiProvidersState>({
    providers: settings.aiProviders,
    defaultProviderId: settings.defaultAiProviderId,
  })
  const updateSettingsRef = useRef(updateSettings)
  useEffect(() => {
    modeRef.current = settings.aiSummaries
    providersRef.current = {
      providers: settings.aiProviders,
      defaultProviderId: settings.defaultAiProviderId,
    }
    updateSettingsRef.current = updateSettings
  })

  // The ask outlives neither the cloud engine nor its answer.
  useEffect(() => {
    if (settings.aiSummaries !== 'cloud' || cloudConfirmed) {
      withdrawNoteSummariesOffer()
    }
  }, [settings.aiSummaries, cloudConfirmed])

  useMainWindowEffect(() => {
    if (!enabled) {
      return
    }
    const controller = createNoteSummaryController({
      generation: graph.generation,
      getProviders: () => providersRef.current,
      getMode: () => modeRef.current,
      cloudConfirmed,
      onConsentNeeded: (consent) => {
        offerNoteSummaries(consent, {
          provider: () => {
            const config = cloudSummaryConfig(providersRef.current)
            return config === null || config === 'on-device' ? null : config.provider
          },
          start: () => updateSettingsRef.current({ aiSummariesCloudConfirmed: true }),
        })
      },
    })
    controller.start()
    return () => {
      controller.dispose()
      withdrawNoteSummariesOffer()
    }
  }, [graph.generation, enabled, cloudConfirmed])
}
