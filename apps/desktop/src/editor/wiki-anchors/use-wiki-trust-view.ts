import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  readNoteLocal,
  wikiClaimStanding,
  wikiClaimTextHashes,
  wikiLocation,
  wikiPathIn,
  wikiSourceLanguage,
  wikiTrustCounts,
  type WikiArticleIndex,
  type WikiClaimStanding,
  type WikiTrustCounts,
  type WikiTrustReport,
} from '@reflect/core'
import { useWikiLanguages } from '@/hooks/use-wiki-languages.ts'
import { useWikiTrustReport } from '@/hooks/use-wiki-trust-report.ts'
import { todayIso } from '@/lib/dates.ts'
import { queryKeys } from '@/lib/query-client.ts'
import { useGraph } from '@/providers/graph-provider.tsx'
import { useSettings } from '@/providers/settings-provider.tsx'
import type { WikiClaimTrust } from './wiki-claim-trust-card.tsx'
import type { WikiTrustView } from './wiki-trust-view.ts'

/** A note's verdict counts, and the claims that need work in reading order. */
export interface WikiTrustSummary {
  readonly counts: WikiTrustCounts
  readonly needsWork: readonly string[]
}

interface TrustViewResult {
  readonly view: WikiTrustView | null
  readonly summary: WikiTrustSummary | null
}

/** The open question on a claim: its latest verdict, by date then file order, is a reader's flag. */
function questionedAt(index: WikiArticleIndex, claimId: string): string | null {
  const ledger = index.ledgers.find((item) => item.valid && item.owner === claimId)
  let latest: { at: string; reader: boolean } | null = null
  for (const pass of ledger?.block.passes ?? []) {
    if (!pass.current || pass.at === null || pass.agent === 'editor') continue
    if (latest === null || pass.at >= latest.at)
      latest = { at: pass.at, reader: pass.agent === 'reader' && pass.status === 'flagged' }
  }
  return latest?.reader === true ? latest.at : null
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
 * The harness's verdicts for the note at `path`, matched to the claims'
 * current text. A translation copy shows its source entry's verdicts, checked
 * against the source's text, and offers no question (the record belongs in
 * the source's ledger). Null while trust display is off or no report loaded.
 */
export function useWikiTrustView(
  path: string,
  index: WikiArticleIndex | null,
  question: (claimId: string) => void,
): TrustViewResult {
  const { graph } = useGraph()
  const { settings } = useSettings()
  const languages = useWikiLanguages()
  const state = useWikiTrustReport()
  const display = settings.wikiTrustDisplay
  const location = wikiLocation(path, languages)
  const source = wikiSourceLanguage(languages)
  const sourcePath =
    location !== null && location.language !== source
      ? wikiPathIn(source, location.relativePath)
      : path
  const translation = sourcePath !== path
  const active = display !== 'off' && state.status === 'ready' && index?.article === true

  const sourceHashes = useQuery({
    queryKey: queryKeys.index.wikiClaimHashes(graph?.root, sourcePath),
    queryFn: async () => {
      const read = await readNoteLocal(sourcePath, graph?.generation)
      return read.kind === 'content' ? await wikiClaimTextHashes(read.content, todayIso()) : null
    },
    enabled: active && translation && graph !== null,
  })

  const [ownHashes, setOwnHashes] = useState<ReadonlyMap<string, string> | null>(null)
  const ownSource = active && !translation ? (index?.source ?? null) : null
  useEffect(() => {
    if (ownSource === null) return
    let live = true
    void wikiClaimTextHashes(ownSource, todayIso()).then((hashes) => {
      if (live) setOwnHashes(hashes)
    })
    return () => {
      live = false
    }
  }, [ownSource])

  const hashes = translation ? (sourceHashes.data ?? null) : ownHashes
  const report = state.status === 'ready' ? state.report : null

  return useMemo((): TrustViewResult => {
    if (display === 'off' || report === null || index === null || hashes === null)
      return { view: null, summary: null }
    const trusts = new Map<string, WikiClaimTrust>()
    for (const claim of index.claims) {
      const hash = hashes.get(claim.id)
      const standing: WikiClaimStanding =
        hash === undefined
          ? { state: 'unevaluated' }
          : wikiClaimStanding(report, sourcePath, claim.id, hash)
      trusts.set(claim.id, {
        claimId: claim.id,
        standing,
        sources: sourcesOf(report, standing),
        questionedAt: translation ? null : questionedAt(index, claim.id),
        ...(translation ? {} : { question: () => question(claim.id) }),
      })
    }
    const standings = [...trusts.values()].map((trust) => trust.standing)
    const needsWork = [...trusts.values()]
      .filter(
        (trust) =>
          trust.standing.state === 'current' && trust.standing.verdict.tier === 'needs-work',
      )
      .map((trust) => trust.claimId)
    return {
      view: { display, claim: (claimId) => trusts.get(claimId) ?? null },
      summary: { counts: wikiTrustCounts(standings), needsWork },
    }
  }, [display, report, index, hashes, sourcePath, translation, question])
}
