import { useEffect, useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  icloudRequestDownloads,
  readNoteLocal,
  readWikiArticle,
  subscribeFileChanges,
  wikiClaimStanding,
  wikiClaimTextHashes,
  wikiLocation,
  wikiPathIn,
  wikiSourceLanguage,
  type WikiArticleIndex,
  type WikiClaimStanding,
  type WikiTrustReport,
} from '@reflect/core'
import { useWikiLanguages } from '@/hooks/use-wiki-languages.ts'
import { shownWikiTrustReport, useWikiTrustReport } from '@/hooks/use-wiki-trust-report.ts'
import { todayIso } from '@/lib/dates.ts'
import { queryKeys } from '@/lib/query-client.ts'
import { useToday } from '@/lib/use-today.ts'
import { useGraph } from '@/providers/graph-provider.tsx'
import { useSettings } from '@/providers/settings-provider.tsx'
import type { WikiClaimTrust } from './wiki-claim-trust-card.tsx'
import type { WikiTrustView } from './wiki-trust-view.ts'

/** What the note footer says about a note's claims. */
export interface WikiNoteTrustSummary {
  /** Claims whose current verdict is Needs work, in reading order. */
  readonly needsWork: readonly string[]
  /** Claims with no verdict for their current text. */
  readonly pending: number
}

interface TrustViewResult {
  readonly view: WikiTrustView | null
  readonly summary: WikiNoteTrustSummary | null
}

/**
 * When to read the saved file again on its own: every 5 s while iCloud has
 * not downloaded it, every 30 s after a failed read (a save's reindex or a
 * new report rereads sooner), otherwise only when asked.
 */
export function savedFileRetryMs(state: {
  readonly status: 'pending' | 'error' | 'success'
  readonly data?: unknown
}): number | false {
  if (state.status === 'error') return 30_000
  return state.data === 'evicted' ? 5000 : false
}

/** The longest claim excerpt the trust card quotes. */
const EXCERPT_CHARS = 160

/** Each range claim's text as the editor holds it, for spotting unsaved edits. */
function claimTexts(index: WikiArticleIndex | null): ReadonlyMap<string, string> {
  const texts = new Map<string, string>()
  if (index === null) return texts
  for (const claim of index.claims)
    if (claim.kind === 'range') texts.set(claim.id, index.source.slice(claim.from, claim.to))
  return texts
}

/** The claim's prose for the card: citations dropped, links read as their labels, shortened. */
function excerptOf(index: WikiArticleIndex, from: number, to: number): string {
  let text = ''
  let at = from
  for (const group of index.groups) {
    if (group.to <= at || group.from >= to) continue
    text += index.source.slice(at, Math.max(at, group.from))
    at = Math.min(to, group.to)
  }
  text += index.source.slice(at, to)
  text = text
    .replaceAll(
      /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
      (_, target: string, alias?: string) => alias ?? target,
    )
    .replaceAll(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replaceAll(/\s+/g, ' ')
    .trim()
  return text.length > EXCERPT_CHARS ? `${text.slice(0, EXCERPT_CHARS - 1).trimEnd()}…` : text
}

/** Whether the reader questioned the claim on `today`: a guard against repeats, not a trust rule. */
function questionedOn(index: WikiArticleIndex, claimId: string, today: string): boolean {
  return index.ledgers.some(
    (ledger) =>
      ledger.valid &&
      ledger.owner === claimId &&
      ledger.block.passes.some(
        (pass) => pass.agent === 'reader' && pass.status === 'flagged' && pass.at === today,
      ),
  )
}

function sourcesOf(
  report: WikiTrustReport,
  standing: WikiClaimStanding,
): WikiClaimTrust['sources'] {
  // A changed claim's sources belong to text that is gone.
  if (standing.state !== 'current') return []
  const sources: WikiClaimTrust['sources'][number][] = []
  for (const key of standing.verdict.sources) {
    const source = report.sources.get(key)
    if (source !== undefined) sources.push({ ...source, key })
  }
  return sources
}

/**
 * The harness's verdicts for the note at `path`, matched to its claims'
 * text. The saved file is hashed as the harness reads it, so the editor's
 * serialization never decides freshness. `asEditor` turns the saved file
 * into the editor's own Markdown, so a claim whose editor text differs from
 * it has an unsaved edit and shows as changed at once. A translation copy
 * shows its source entry's verdicts and offers no question (the record
 * belongs in the source's ledger). `question` is absent where the note is
 * read-only. Null while trust display is off, no report loaded, or the
 * report leaves the note out.
 */
export function useWikiTrustView(
  path: string,
  index: WikiArticleIndex | null,
  question: ((claimId: string) => boolean) | undefined,
  asEditor: (markdown: string) => string,
): TrustViewResult {
  const { graph } = useGraph()
  const { settings } = useSettings()
  const languages = useWikiLanguages()
  const report = shownWikiTrustReport(useWikiTrustReport())
  const today = useToday()
  const display = settings.wikiTrustDisplay
  const location = wikiLocation(path, languages)
  const source = wikiSourceLanguage(languages)
  const sourcePath =
    location !== null && location.language !== source
      ? wikiPathIn(source, location.relativePath)
      : path
  const translation = sourcePath !== path
  const covered = report?.notes.has(sourcePath.normalize('NFC')) === true
  const active = display !== 'off' && covered && index?.article === true

  // Under the index keys, so the reindex after a save re-reads the file.
  const root = graph?.root
  const savedKey = useMemo(
    () => queryKeys.index.wikiClaimHashes(root, sourcePath),
    [root, sourcePath],
  )
  const savedQuery = useQuery({
    queryKey: savedKey,
    // A real fetcher even when this observer is idle: a translation and its
    // source share the key, and an idle observer must not strip the other's.
    queryFn: async () => {
      if (graph === null) throw new Error('No graph is open.')
      const read = await readNoteLocal(sourcePath, graph.generation)
      if (read.kind === 'content')
        return {
          content: read.content,
          hashes: await wikiClaimTextHashes(read.content, todayIso()),
        }
      // Materializing an unchanged file reindexes nothing, so poll for it.
      await icloudRequestDownloads([sourcePath])
      return 'evicted' as const
    },
    enabled: active && graph !== null,
    refetchInterval: (query) => savedFileRetryMs(query.state),
  })
  // A new report rereads the file too, so freshness never hangs on the index
  // lifecycle (which may be unavailable while editing still works).
  // The report keeps its identity across polls of an unchanged file.
  const client = useQueryClient()
  useEffect(() => {
    if (!active || report === null) return
    void client.refetchQueries({ queryKey: savedKey, exact: true }, { cancelRefetch: false })
  }, [client, active, report, savedKey])
  // A change to the file itself (a save here, an edit elsewhere) rereads it
  // without waiting for the index, which may be unavailable.
  useEffect(() => {
    if (!active) return
    let live = true
    let unlisten: (() => void) | null = null
    void subscribeFileChanges((changes) => {
      if (changes.some((change) => change.path === sourcePath))
        void client.refetchQueries({ queryKey: savedKey, exact: true }, { cancelRefetch: false })
    }).then((stop) => {
      if (live) unlisten = stop
      else stop()
    })
    return () => {
      live = false
      unlisten?.()
    }
  }, [client, active, savedKey, sourcePath])
  // Returning to the window rereads too: a source edited in another app
  // reaches no index invalidation while the index is unavailable.
  useEffect(() => {
    if (!active) return
    const reread = (): void => {
      void client.refetchQueries({ queryKey: savedKey, exact: true }, { cancelRefetch: false })
    }
    window.addEventListener('focus', reread)
    return () => window.removeEventListener('focus', reread)
  }, [client, active, savedKey])
  // A failed reread (the source deleted or unreadable) keeps the old data in
  // the cache; trust nothing from it.
  const saved = savedQuery.isError ? undefined : savedQuery.data
  const file = saved === undefined || saved === 'evicted' ? null : saved
  const loaded = file?.hashes ?? null

  // The saved claims as the editor would hold them; editor text that differs
  // is an unsaved edit. Translations are compared through their source.
  const texts = useMemo(() => claimTexts(index), [index])
  const content = translation ? null : (file?.content ?? null)
  const savedTexts = useMemo(
    () => (content === null ? null : claimTexts(readWikiArticle(asEditor(content), todayIso()))),
    [content, asEditor],
  )

  return useMemo((): TrustViewResult => {
    if (display === 'off' || !covered || report === null || index === null || loaded === null)
      return { view: null, summary: null }
    const trusts = new Map<string, WikiClaimTrust>()
    // Legacy heading claims carry no trust: their ledger sits inside their range.
    for (const claim of index.claims) {
      if (claim.kind !== 'range') continue
      const hash = loaded.get(claim.id)
      let standing: WikiClaimStanding =
        hash === undefined
          ? { state: 'unevaluated' }
          : wikiClaimStanding(report, sourcePath, claim.id, hash)
      const edited = savedTexts !== null && savedTexts.get(claim.id) !== texts.get(claim.id)
      if (edited && standing.state === 'current')
        standing = { state: 'changed', verdict: standing.verdict }
      trusts.set(claim.id, {
        claimId: claim.id,
        excerpt: excerptOf(index, claim.from, claim.to),
        standing,
        sources: sourcesOf(report, standing),
        sourceThreshold: report.sourceThreshold,
        questionedToday: !translation && questionedOn(index, claim.id, today),
        ...(translation || question === undefined ? {} : { question: () => question(claim.id) }),
      })
    }
    const all = [...trusts.values()]
    return {
      view: { display, claim: (claimId) => trusts.get(claimId) ?? null },
      summary: {
        needsWork: all
          .filter(
            (trust) =>
              trust.standing.state === 'current' && trust.standing.verdict.tier === 'needs-work',
          )
          .map((trust) => trust.claimId),
        pending: all.filter((trust) => trust.standing.state !== 'current').length,
      },
    }
  }, [
    display,
    covered,
    report,
    index,
    loaded,
    savedTexts,
    texts,
    sourcePath,
    translation,
    question,
    today,
  ])
}
