import { useEffect, useRef, type ReactElement, type ReactNode } from 'react'
import type { AiProvidersState, GraphInfo } from '@reflect/core'
import { createAssetDescribeController } from '@/lib/asset-describe-controller.ts'
import { startAssetOcrMaintenance } from '@/lib/asset-ocr-maintenance-controller.ts'
import { useMainWindowEffect } from '@/hooks/use-main-window-effect.ts'
import { useSettings } from '@/providers/settings-provider.tsx'

/**
 * Mounts the asset-description lifecycle for the open graph (Plan 20): runs the
 * description loop for new attachments when enabled. Local OCR uses the
 * device-only cache; default AI descriptions use managed sidecars. Existing
 * local OCR is maintained across source changes even when generation is off.
 */

interface AssetDescribeProviderProps {
  graph: GraphInfo
  children: ReactNode
}

export function AssetDescribeProvider({
  graph,
  children,
}: AssetDescribeProviderProps): ReactElement {
  const { settings } = useSettings()
  const describeAssets = settings.describeAssets
  const localOcrProviderIdRef = useRef(settings.localOcrProviderId)
  useEffect(() => {
    localOcrProviderIdRef.current = settings.localOcrProviderId
  })

  // Read lazily at the start of every pass — a key added in Settings
  // mid-session must be seen without rebuilding the controller.
  const providersRef = useRef<AiProvidersState>({
    providers: settings.aiProviders,
    defaultProviderId: settings.defaultAiProviderId,
  })
  useEffect(() => {
    providersRef.current = {
      providers: settings.aiProviders,
      defaultProviderId: settings.defaultAiProviderId,
    }
  })

  // Main window only — two describers would double-bill the same assets.
  useMainWindowEffect(() => startAssetOcrMaintenance(graph.generation), [graph.generation])
  useMainWindowEffect(() => {
    if (!describeAssets) {
      return
    }
    const controller = createAssetDescribeController({
      generation: graph.generation,
      getProviders: () => providersRef.current,
      getLocalOcrProviderId: () => localOcrProviderIdRef.current,
    })
    controller.start()
    return () => {
      controller.dispose()
    }
  }, [graph.generation, describeAssets, settings.localOcrProviderId])

  return <>{children}</>
}
