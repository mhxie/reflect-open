import { useEffect, useRef } from 'react'
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import {
  errorMessage,
  parseWikiTrustReport,
  type WikiService,
  type WikiTrustReport,
  type WikiTrustReportFile,
} from '@reflect/core'
import { queryKeys } from '@/lib/query-client.ts'
import { useGraph } from '@/providers/graph-provider.tsx'
import { useSyncContext } from '@/providers/sync-provider.tsx'
import { useSettings } from '@/providers/settings-provider.tsx'
import { useCoreServices } from '@/services/services-provider.tsx'

/** How often an open graph re-checks the report file for a new version. */
const POLL_MS = 5000
/** The slower check while no report exists, as in a graph no harness writes to. */
const MISSING_POLL_MS = 30_000

/** What Reflect knows of the harness's trust report. */
export type WikiTrustReportState =
  | { readonly status: 'off' }
  | { readonly status: 'loading' }
  | { readonly status: 'missing'; readonly path: string }
  | WikiTrustReportReady
  | {
      readonly status: 'invalid' | 'unreadable'
      readonly path: string
      readonly error: string
      /** The last version of the file seen, if any. */
      readonly stamp: string | null
      /** The last report that parsed, still shown while this read fails. */
      readonly last: WikiTrustReportReady | null
    }

interface WikiTrustReportReady {
  readonly status: 'ready'
  readonly path: string
  readonly report: WikiTrustReport
  /** Entries the report carried that did not validate. */
  readonly ignored: number
  readonly stamp: string
}

type Loaded = Exclude<WikiTrustReportState, { status: 'off' } | { status: 'loading' }>

/**
 * The report to draw from: the current one, or the last that parsed while a
 * read fails (a file caught mid-write recovers on the next poll).
 */
export function shownWikiTrustReport(state: WikiTrustReportState): WikiTrustReport | null {
  if (state.status === 'ready') return state.report
  if (state.status === 'invalid' || state.status === 'unreadable') return state.last?.report ?? null
  return null
}

async function loadReport(
  wiki: WikiService,
  client: QueryClient,
  key: readonly unknown[],
  path: string,
  changed: () => void,
): Promise<Loaded> {
  const previous = client.getQueryData<Loaded>(key)
  const last =
    previous?.status === 'ready'
      ? previous
      : previous?.status === 'invalid' || previous?.status === 'unreadable'
        ? previous.last
        : null
  // Only a report that parsed is kept by stamp; anything else is read again.
  const known = previous?.status === 'ready' ? previous.stamp : null
  const before =
    previous === undefined || previous.status === 'missing' ? null : (previous.stamp ?? null)
  let file: WikiTrustReportFile | null
  try {
    file = await wiki.readTrustReportFile(path, known)
  } catch (cause) {
    return { status: 'unreadable', path, error: errorMessage(cause), last, stamp: before }
  }
  // A report under a hidden folder escapes the file watcher, and so backup:
  // tell it once per version seen, the first included, and per deletion.
  // Before backup starts, its launch cycle commits the tree, report included.
  if ((file?.stamp ?? null) !== before) changed()
  if (file === null) return { status: 'missing', path }
  if (file.contents === null && previous?.status === 'ready') return previous
  const parsed = parseWikiTrustReport(file.contents ?? '')
  return parsed.ok
    ? {
        status: 'ready',
        path,
        report: parsed.report,
        ignored: parsed.ignored,
        stamp: file.stamp,
      }
    : { status: 'invalid', path, error: parsed.error, last, stamp: file.stamp }
}

/**
 * The open graph's wiki trust report, re-read whenever the harness replaces
 * the file (checked every few seconds, every half minute while there is no
 * file, and on window focus; an unchanged file costs one stat). `off` when
 * trust display is off, unless `always` is set, as Settings and the backup
 * watcher do.
 */
export function useWikiTrustReport(always = false): WikiTrustReportState {
  const { graph } = useGraph()
  const { wiki } = useCoreServices()
  const { settings } = useSettings()
  const client = useQueryClient()
  // Read when a report arrives, not when its read began: backup may start
  // while a read is still in flight.
  const syncContext = useSyncContext()
  const syncRef = useRef(syncContext)
  useEffect(() => {
    syncRef.current = syncContext
  })
  const path = settings.wikiTrustReportPath
  const enabled = graph !== null && (always || settings.wikiTrustDisplay !== 'off')
  const open = graph !== null
  const root = graph?.root
  const key = queryKeys.wikiTrust.report(root, path)
  // A Tauri window regaining focus fires `focus` without `visibilitychange`,
  // which is all the query library's own focus refetch hears.
  useEffect(() => {
    if (!enabled) return
    const queryKey = queryKeys.wikiTrust.report(root, path)
    const refetch = (): void => {
      void client.refetchQueries({ queryKey, exact: true }, { cancelRefetch: false })
    }
    window.addEventListener('focus', refetch)
    return () => window.removeEventListener('focus', refetch)
  }, [enabled, client, root, path])
  const { data } = useQuery({
    queryKey: key,
    // A real fetcher even when this observer is idle: the always-on watcher
    // and a display-off editor share the key.
    queryFn: () =>
      open
        ? loadReport(wiki, client, key, path, () => syncRef.current?.fileChanged())
        : Promise.reject(new Error('No graph is open.')),
    enabled,
    refetchInterval: (query) =>
      query.state.data?.status === 'missing' ? MISSING_POLL_MS : POLL_MS,
    // The backup watcher polls with the window hidden too: the file watcher
    // skips the report's folder, so nothing else tells backup it changed.
    refetchIntervalInBackground: always,
    refetchOnWindowFocus: 'always',
    structuralSharing: false,
  })
  if (!enabled) return { status: 'off' }
  return data ?? { status: 'loading' }
}
