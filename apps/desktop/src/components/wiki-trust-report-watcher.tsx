import { useWikiTrustReport } from '@/hooks/use-wiki-trust-report.ts'

/**
 * Keeps the report under watch for the open graph's lifetime, so a new
 * version reaches Git backup even when no note or Settings shows it.
 */
export function WikiTrustReportWatcher(): null {
  useWikiTrustReport(true)
  return null
}
