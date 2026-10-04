import type { GraphInfo } from '@reflect/core'
import { startOperation } from '@/lib/operations.ts'

/**
 * Show a graph's backup settings problems (a size limit out of range, a
 * malformed accepted history root, a key naming a missing folder) when it
 * opens: Git backup then falls back to its default limit, or pauses on a
 * history the user meant to accept, which a typo would otherwise hide.
 * Persistent until dismissed.
 */
export function reportBackupWarnings(info: GraphInfo): void {
  const warnings = info.backupWarnings ?? []
  if (warnings.length > 0) {
    startOperation('Backup settings', { persistent: true }).warn(warnings.join(' '))
  }
}
