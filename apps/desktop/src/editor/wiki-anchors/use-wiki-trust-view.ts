import { useEffect, useMemo, useState } from 'react'
import { skipToken, useQuery } from '@tanstack/react-query'
import {
  icloudRequestDownloads,
  readNoteLocal,
  wikiClaimStanding,
  wikiClaimTextHashes,
  wikiClaimTextSha256,
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
import { hasUnsavedEdit, nextSavedClaims, type SavedClaim } from './wiki-trust-edits.ts'
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

/** How often a source note iCloud has not downloaded yet is checked again. */
const EVICTED_RETRY_MS = 5000

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
 * serialization never decides freshness; a claim typed in since the file
 * was read shows as changed at once. A translation copy shows its source entry's
 * verdicts and offers no question (the record belongs in the source's
 * ledger). `question` is absent where the note is read-only. Null while
 * trust display is off, no report loaded, or the report leaves the note out.
 */
export function useWikiTrustView(
  path: string,
  index: WikiArticleIndex | null,
  question: ((claimId: string) => boolean) | undefined,
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
  const hashes = useQuery({
    queryKey: queryKeys.index.wikiClaimHashes(graph?.root, sourcePath),
    queryFn:
      active && graph !== null
        ? async () => {
            const read = await readNoteLocal(sourcePath, graph.generation)
            if (read.kind === 'content') return await wikiClaimTextHashes(read.content, todayIso())
            // Materializing an unchanged file reindexes nothing, so poll for it.
            await icloudRequestDownloads([sourcePath])
            return 'evicted' as const
          }
        : skipToken,
    refetchInterval: (query) => (query.state.data === 'evicted' ? EVICTED_RETRY_MS : false),
  }).data
  const loaded = hashes === undefined || hashes === 'evicted' ? null : hashes

  // Unsaved edits: each claim's editor text is snapshotted per saved file
  // version, and the editor's own hashes clear a claim that shows the file.
  const texts = useMemo(() => claimTexts(index), [index])
  const tracking = active && !translation && index !== null
  const [editorHashes, setEditorHashes] = useState<{
    readonly texts: ReadonlyMap<string, string>
    readonly hashes: ReadonlyMap<string, string>
  } | null>(null)
  useEffect(() => {
    if (!tracking) return
    let live = true
    void Promise.all(
      [...texts].map(async ([id, text]) => [id, await wikiClaimTextSha256(text)] as const),
    ).then((entries) => {
      if (live) setEditorHashes({ texts, hashes: new Map(entries) })
    })
    return () => {
      live = false
    }
  }, [tracking, texts])
  const shownHashes = editorHashes?.texts === texts ? editorHashes.hashes : null
  const [savedClaims, setSavedClaims] = useState<ReadonlyMap<string, SavedClaim>>(new Map())
  if (tracking && loaded !== null) {
    const next = nextSavedClaims(savedClaims, loaded, texts, shownHashes)
    if (next !== savedClaims) setSavedClaims(next)
  }

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
      const edited =
        !translation &&
        hasUnsavedEdit(savedClaims, claim.id, texts.get(claim.id), shownHashes?.get(claim.id))
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
    savedClaims,
    shownHashes,
    texts,
    sourcePath,
    translation,
    question,
    today,
  ])
}
