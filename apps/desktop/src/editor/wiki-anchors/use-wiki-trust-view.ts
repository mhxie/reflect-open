import { useMemo } from 'react'
import { skipToken, useQuery } from '@tanstack/react-query'
import {
  readNoteLocal,
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
import { useGraph } from '@/providers/graph-provider.tsx'
import { useSettings } from '@/providers/settings-provider.tsx'
import type { WikiClaimTrust } from './wiki-claim-trust-card.tsx'
import type { WikiTrustView } from './wiki-trust-view.ts'

/** What the note footer says about a note's claims. */
export interface WikiNoteTrustSummary {
  /** Claims whose current verdict is Needs work, in reading order. */
  readonly needsWork: readonly string[]
  /** Claims with no verdict for their saved text. */
  readonly pending: number
}

interface TrustViewResult {
  readonly view: WikiTrustView | null
  readonly summary: WikiNoteTrustSummary | null
}

/** The longest claim excerpt the trust card quotes. */
const EXCERPT_CHARS = 160

function excerptOf(source: string, from: number, to: number): string {
  const text = source.slice(from, to).replaceAll(/\s+/g, ' ').trim()
  return text.length > EXCERPT_CHARS ? `${text.slice(0, EXCERPT_CHARS - 1).trimEnd()}…` : text
}

/** Whether the reader already questioned the claim today: a guard against repeats, not a trust rule. */
function questionedToday(index: WikiArticleIndex, claimId: string, today: string): boolean {
  const ledger = index.ledgers.find((item) => item.valid && item.owner === claimId)
  return (
    ledger?.block.passes.some(
      (pass) => pass.agent === 'reader' && pass.status === 'flagged' && pass.at === today,
    ) === true
  )
}

function sourcesOf(
  report: WikiTrustReport,
  standing: WikiClaimStanding,
): WikiClaimTrust['sources'] {
  if (standing.state === 'unevaluated') return []
  const sources: WikiClaimTrust['sources'][number][] = []
  for (const key of standing.verdict.sources) {
    const source = report.sources.get(key)
    if (source !== undefined) sources.push({ ...source, key })
  }
  return sources
}

/**
 * The harness's verdicts for the note at `path`, matched to its claims'
 * saved text. The file is hashed as the harness reads it, so the editor's
 * serialization never decides freshness and an edit counts once saved. A
 * translation copy shows its source entry's verdicts and offers no question
 * (the record belongs in the source's ledger). `question` is absent where the
 * note is read-only. Null while trust display is off or no report loaded.
 */
export function useWikiTrustView(
  path: string,
  index: WikiArticleIndex | null,
  question: ((claimId: string) => void) | undefined,
): TrustViewResult {
  const { graph } = useGraph()
  const { settings } = useSettings()
  const languages = useWikiLanguages()
  const report = shownWikiTrustReport(useWikiTrustReport())
  const display = settings.wikiTrustDisplay
  const location = wikiLocation(path, languages)
  const source = wikiSourceLanguage(languages)
  const sourcePath =
    location !== null && location.language !== source
      ? wikiPathIn(source, location.relativePath)
      : path
  const translation = sourcePath !== path
  const active = display !== 'off' && report !== null && index?.article === true

  // Under the index keys, so the reindex after a save re-reads the file.
  const hashes = useQuery({
    queryKey: queryKeys.index.wikiClaimHashes(graph?.root, sourcePath),
    queryFn:
      active && graph !== null
        ? async () => {
            const read = await readNoteLocal(sourcePath, graph.generation)
            return read.kind === 'content'
              ? await wikiClaimTextHashes(read.content, todayIso())
              : null
          }
        : skipToken,
  }).data

  return useMemo((): TrustViewResult => {
    if (display === 'off' || report === null || index === null || hashes == null)
      return { view: null, summary: null }
    const today = todayIso()
    const trusts = new Map<string, WikiClaimTrust>()
    // Legacy heading claims carry no trust: their ledger sits inside their range.
    for (const claim of index.claims) {
      if (claim.kind !== 'range') continue
      const hash = hashes.get(claim.id)
      const standing: WikiClaimStanding =
        hash === undefined
          ? { state: 'unevaluated' }
          : wikiClaimStanding(report, sourcePath, claim.id, hash)
      trusts.set(claim.id, {
        claimId: claim.id,
        excerpt: excerptOf(index.source, claim.from, claim.to),
        standing,
        sources: sourcesOf(report, standing),
        sourceThreshold: report.sourceThreshold,
        questionedToday: !translation && questionedToday(index, claim.id, today),
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
  }, [display, report, index, hashes, sourcePath, translation, question])
}
