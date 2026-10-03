import type { GraphInfo } from '@reflect/core'
import { startOperation } from '@/lib/operations.ts'

/**
 * Show a graph's backup size limit problems (a value out of range, a key
 * naming a missing folder) when it opens: Git backup then falls back to its
 * default limit, which a typo would otherwise hide. Persistent until
 * dismissed.
 */
export function reportBackupWarnings(info: GraphInfo): void {
  const warnings = info.backupWarnings ?? []
  if (warnings.length > 0) {
    startOperation('Backup size limit', { persistent: true }).warn(warnings.join(' '))
  }
}
