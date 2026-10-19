import type { OperationsService } from '@reflect/app'
import type { GraphInfo } from '@reflect/core'

/**
 * Show a graph's local-only configuration problems (a dropped folder name, an
 * unusable rawRoot, an unreadable settings file) when it opens: a typo there
 * would otherwise leave a folder silently unprotected. Persistent until
 * dismissed.
 */
export function reportLocalOnlyWarnings(operations: OperationsService, info: GraphInfo): void {
  const warnings = info.localOnlyWarnings ?? []
  if (warnings.length > 0) {
    operations.start('Local-only folders', { persistent: true }).warn(warnings.join(' '))
  }
}
