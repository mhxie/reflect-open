import { useEffect } from 'react'
import {
  checkForLocalModelUpdates,
  clearPendingLocalModelUpdate,
} from '@/lib/local-model-updates.ts'
import { isMacosDesktop } from '@/lib/platform.ts'
import { useLocalModelStatus } from '@/lib/use-local-model-status.ts'
import { isMainWindow } from '@/lib/windows/window-role.ts'
import { useSettings } from '@/providers/settings-provider.tsx'

/**
 * How often a long-running session asks again. Rust throttles the network
 * check to once a day; this only makes sure a session left open for days
 * still gets there.
 */
const RECHECK_MS = 6 * 60 * 60 * 1000

/**
 * Watches the on-device transcription model's upstream for newer weights
 * while that engine is chosen and its model is downloaded. Renders nothing;
 * mounted once per workspace, active in the main window only so note windows
 * don't repeat the check or its offer.
 */
export function LocalModelUpdates(): null {
  const { settings } = useSettings()
  const model = settings.localTranscriptionModel
  const active =
    isMacosDesktop &&
    isMainWindow() &&
    settings.transcriptionEngine === 'local' &&
    settings.localTranscriptionUpdateChecks
  const ready = useLocalModelStatus(model, active).status === 'ready'

  useEffect(() => {
    if (!active || !ready) {
      return
    }
    void checkForLocalModelUpdates(model, false)
    const timer = window.setInterval(() => void checkForLocalModelUpdates(model, false), RECHECK_MS)
    return () => window.clearInterval(timer)
  }, [active, ready, model])

  // An offer for another model, or for an engine no longer chosen, is stale.
  useEffect(() => {
    return () => clearPendingLocalModelUpdate()
  }, [active, model])

  return null
}
