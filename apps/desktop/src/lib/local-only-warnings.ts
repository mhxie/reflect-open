import type { GraphInfo } from '@reflect/core'
import { startOperation } from '@/lib/operations.ts'

/**
 * Show a graph's local-only configuration problems (a dropped folder name, an
 * unusable rawRoot, an unreadable settings file) when it opens: a typo there
 * would otherwise leave a folder silently unprotected. Persistent until
 * dismissed.
 */
export function reportLocalOnlyWarnings(info: GraphInfo): void {
  const warnings = info.localOnlyWarnings ?? []
  if (warnings.length > 0) {
    startOperation('Local-only folders', { persistent: true }).warn(warnings.join(' '))
  }
}
