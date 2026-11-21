import type { OperationsService } from '@reflect/app'
import type { GraphInfo } from '@reflect/core'

/**
 * Show a graph's backup settings problems (a size limit out of range, a
 * malformed accepted history root, a key naming a missing folder) when it
 * opens: Git backup then falls back to its default limit, or pauses on a
 * history the user meant to accept, which a typo would otherwise hide.
 * Persistent until dismissed.
 */
export function reportBackupWarnings(operations: OperationsService, info: GraphInfo): void {
  const warnings = info.backupWarnings ?? []
  if (warnings.length > 0) {
    operations.start('Backup settings', { persistent: true }).warn(warnings.join(' '))
  }
}
