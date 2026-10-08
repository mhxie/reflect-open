import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import {
  errorMessage,
  parseWikiTrustReport,
  readWikiTrustReportFile,
  type WikiTrustReport,
} from '@reflect/core'
import { useBridgeReady } from '@/hooks/use-bridge-ready.ts'
import { queryKeys } from '@/lib/query-client.ts'
import { useGraph } from '@/providers/graph-provider.tsx'
import { useSettings } from '@/providers/settings-provider.tsx'

/** How often an open graph re-checks the report file for a new version. */
const POLL_MS = 5000

/** What Reflect knows of the harness's trust report. */
export type WikiTrustReportState =
  | { readonly status: 'off' }
  | { readonly status: 'loading' }
  | { readonly status: 'missing'; readonly path: string }
  | {
      readonly status: 'ready'
      readonly path: string
      readonly report: WikiTrustReport
      /** Entries the report carried that did not validate. */
      readonly ignored: number
      readonly modifiedMs: number | null
    }
  | {
      readonly status: 'invalid'
      readonly path: string
      readonly error: string
      readonly modifiedMs: number | null
    }
  | { readonly status: 'unreadable'; readonly path: string; readonly error: string }

type Loaded = Exclude<WikiTrustReportState, { status: 'off' } | { status: 'loading' }>

async function loadReport(
  client: QueryClient,
  key: readonly unknown[],
  path: string,
  generation: number,
): Promise<Loaded> {
  const previous = client.getQueryData<Loaded>(key)
  const known =
    previous?.status === 'ready' || previous?.status === 'invalid' ? previous.modifiedMs : null
  let file: Awaited<ReturnType<typeof readWikiTrustReportFile>>
  try {
    file = await readWikiTrustReportFile(path, known, generation)
  } catch (cause) {
    return { status: 'unreadable', path, error: errorMessage(cause) }
  }
  if (file === null) return { status: 'missing', path }
  if (file.contents === null && previous !== undefined) return previous
  const parsed = parseWikiTrustReport(file.contents ?? '')
  return parsed.ok
    ? {
        status: 'ready',
        path,
        report: parsed.report,
        ignored: parsed.ignored,
        modifiedMs: file.modifiedMs,
      }
    : { status: 'invalid', path, error: parsed.error, modifiedMs: file.modifiedMs }
}

/**
 * The open graph's wiki trust report, re-read whenever the harness replaces
 * the file (checked every few seconds and on window focus; an unchanged file
 * costs one stat). `off` when trust display is off, unless `always` is set,
 * as Settings does to show the report's status while display is off.
 */
export function useWikiTrustReport(always = false): WikiTrustReportState {
  const { graph } = useGraph()
  const bridgeReady = useBridgeReady()
  const { settings } = useSettings()
  const client = useQueryClient()
  const path = settings.wikiTrustReportPath
  const enabled = graph !== null && bridgeReady && (always || settings.wikiTrustDisplay !== 'off')
  const generation = graph?.generation
  const key = queryKeys.wikiTrust.report(graph?.root, path)
  const { data } = useQuery({
    queryKey: key,
    queryFn: () =>
      generation === undefined
        ? Promise.resolve<Loaded>({ status: 'unreadable', path, error: 'No graph is open.' })
        : loadReport(client, key, path, generation),
    enabled,
    refetchInterval: POLL_MS,
    refetchOnWindowFocus: 'always',
    structuralSharing: false,
  })
  if (!enabled) return { status: 'off' }
  return data ?? { status: 'loading' }
}
