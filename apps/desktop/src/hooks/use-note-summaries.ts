import { useEffect, useRef } from 'react'
import type { AiProvidersState, AiSummaryMode, GraphInfo } from '@reflect/core'
import { useMainWindowEffect } from '@/hooks/use-main-window-effect.ts'
import { createNoteSummaryController } from '@/lib/note-summary-controller.ts'
import { useSettings } from '@/providers/settings-provider.tsx'

/**
 * Runs the AI note-summary lifecycle for the open graph: long notes get a
 * one-sentence `aiSummary` that the All Notes list shows in place of their
 * opening text. Main window only — two summarizers would double-bill and race
 * the writes — and off when the `aiSummaries` setting is.
 */
export function useNoteSummaries(graph: GraphInfo): void {
  const { settings } = useSettings()
  const enabled = settings.aiSummaries !== 'off'

  // Read lazily at the start of every pass — a provider or mode changed in
  // Settings mid-session must be seen without rebuilding the controller.
  const modeRef = useRef<AiSummaryMode>(settings.aiSummaries)
  const providersRef = useRef<AiProvidersState>({
    providers: settings.aiProviders,
    defaultProviderId: settings.defaultAiProviderId,
  })
  useEffect(() => {
    modeRef.current = settings.aiSummaries
    providersRef.current = {
      providers: settings.aiProviders,
      defaultProviderId: settings.defaultAiProviderId,
    }
  })

  useMainWindowEffect(() => {
    if (!enabled) {
      return
    }
    const controller = createNoteSummaryController({
      generation: graph.generation,
      getProviders: () => providersRef.current,
      getMode: () => modeRef.current,
    })
    controller.start()
    return () => {
      controller.dispose()
    }
  }, [graph.generation, enabled])
}
