import {
  wikiSourceKey,
  type WikiAnchorsBlock,
  type WikiReviewPass,
  type WikiSource,
} from './anchors.ts'

/**
 * How well a claim stands, strongest first. Only external evidence earns a
 * tier; an adversarial review is the gate between Supported and Solid, never a
 * substitute for evidence (Plan 30, after the atelier wiki schema).
 */
export type WikiTrustTier = 'solid' | 'supported' | 'needs-work'

/**
 * Review states shown beside the tier: `disputed` (the latest verdict, an
 * agent's or a reader's, flagged the claim or could not confirm it; caps the
 * tier at Needs work) and
 * `edited` (the text changed after its last review).
 */
export type WikiTrustOverlay = 'disputed' | 'edited'

/** One fact behind a claim's tier, in the order a reader should see it. */
export type WikiTrustReason =
  | {
      readonly kind: 'evidence'
      /** Independent current origins (see {@link wikiSourceOrigin}). */
      readonly origins: number
      /** How many of those origins hold a primary source. */
      readonly primary: number
    }
  | { readonly kind: 'citation'; readonly tier: WikiTrustTier }
  | { readonly kind: 'adversarial-review'; readonly agent: string; readonly at: string }
  | {
      readonly kind: 'disputed'
      readonly agent: string
      readonly status: string
      readonly at: string
    }
  | { readonly kind: 'edited'; readonly at: string }

/** A claim's tier, its overlays, and the reasons for both. */
export interface WikiClaimTrust {
  readonly tier: WikiTrustTier
  readonly overlays: readonly WikiTrustOverlay[]
  readonly reasons: readonly WikiTrustReason[]
}

/** What a claim's trust is computed from. */
export interface WikiClaimTrustInput {
  /** The claim's evidence ledger, read as of the day being judged; null when it has none. */
  readonly ledger: WikiAnchorsBlock | null
  /** The tiers of the current claims this claim cites inside its range. */
  readonly citedTiers: readonly WikiTrustTier[]
}

const PRIMARY_TYPES = new Set(['s2', 'arxiv', 'doi', 'isbn'])
const ADVERSARIAL_AGENTS = new Set(['challenger', 'scout'])
const DISPUTED_STATUSES = new Set(['flagged', 'inconclusive'])
/** The only status each constrained agent may record: an editor flags review work, a reader doubts. */
const CONSTRAINED_STATUS: ReadonlyMap<string, string> = new Map([
  ['editor', 'pending'],
  ['reader', 'flagged'],
])

/** Whether a pass is one its agent may record; any other is ignored. */
function permittedPass(pass: WikiReviewPass): boolean {
  const status = CONSTRAINED_STATUS.get(pass.agent)
  return status === undefined || pass.status === status
}
/** Hosts whose first path segment names an independent author or project. */
const CODE_HOSTS = new Set([
  'github.com',
  'gist.github.com',
  'raw.githubusercontent.com',
  'gitlab.com',
])
const ARXIV_PATH_RE =
  /^\/(?:abs|pdf|html)\/(\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z]{2})?\/\d{7})(?:v\d+)?(?:\.pdf)?\/?$/i
const ORDER: readonly WikiTrustTier[] = ['needs-work', 'supported', 'solid']

/** The paper id a scholarly URL names (`arxiv:2409.19256`), or null for any other URL. */
function scholarlyUrlKey(url: URL, host: string): string | null {
  if (host === 'arxiv.org') {
    const id = ARXIV_PATH_RE.exec(url.pathname)?.[1]
    return id === undefined ? null : `arxiv:${id.toLowerCase()}`
  }
  if (host === 'doi.org' || host === 'dx.doi.org') {
    const doi = decodeURIComponent(url.pathname.slice(1))
    return doi === '' ? null : `doi:${doi.toLowerCase()}`
  }
  return null
}

/**
 * The independent origin a source counts toward: a paper or book by its
 * identifier (an arXiv or DOI link names its paper), a code host by its author
 * or project, and any other page by its host, so two pages of one site's
 * documentation are one origin.
 */
export function wikiSourceOrigin(source: Pick<WikiSource, 'type' | 'id'>): string {
  if (source.type !== 'url' && source.type !== 'gist') {
    return wikiSourceKey(`${source.type}:${source.id}`)
  }
  let url: URL
  try {
    url = new URL(source.id)
  } catch {
    return wikiSourceKey(`${source.type}:${source.id}`)
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, '')
  const scholarly = scholarlyUrlKey(url, host)
  if (scholarly !== null) return scholarly
  if (CODE_HOSTS.has(host)) {
    const owner = url.pathname.split('/').find((segment) => segment !== '') ?? ''
    return `code:${owner.toLowerCase()}`
  }
  return `host:${host}`
}

/**
 * Whether a source is primary: the writer's `kind` when stated, else papers,
 * books, and links to them.
 */
export function isPrimaryWikiSource(source: Pick<WikiSource, 'type' | 'id' | 'kind'>): boolean {
  if (source.kind !== null) return source.kind === 'primary'
  const origin = wikiSourceOrigin(source)
  return PRIMARY_TYPES.has(origin.slice(0, origin.indexOf(':')))
}

interface DatedPass {
  readonly pass: WikiReviewPass
  readonly at: string
  readonly order: number
}

/** Whether `left` was recorded after `right`: by date, then by file order. */
function after(left: DatedPass, right: DatedPass): boolean {
  return left.at > right.at || (left.at === right.at && left.order > right.order)
}

function latest(passes: readonly DatedPass[]): DatedPass | null {
  let result: DatedPass | null = null
  for (const pass of passes) {
    if (result === null || after(pass, result)) result = pass
  }
  return result
}

function higher(left: WikiTrustTier, right: WikiTrustTier): WikiTrustTier {
  return ORDER.indexOf(left) >= ORDER.indexOf(right) ? left : right
}

/** One claim's trust from its own ledger and the tiers of the claims it cites. */
export function wikiClaimTrust({ ledger, citedTiers }: WikiClaimTrustInput): WikiClaimTrust {
  const reasons: WikiTrustReason[] = []
  const overlays: WikiTrustOverlay[] = []

  const origins = new Map<string, boolean>()
  for (const source of ledger?.sources ?? []) {
    if (!source.current) continue
    const origin = wikiSourceOrigin(source)
    origins.set(origin, (origins.get(origin) ?? false) || isPrimaryWikiSource(source))
  }
  const primary = [...origins.values()].filter(Boolean).length
  reasons.push({ kind: 'evidence', origins: origins.size, primary })
  const strong = origins.size >= 2 && primary >= 1
  let tier: WikiTrustTier = strong || primary >= 1 || origins.size >= 2 ? 'supported' : 'needs-work'

  const cited = citedTiers.reduce<WikiTrustTier | null>(
    (best, cited) => (best === null ? cited : higher(best, cited)),
    null,
  )
  if (cited !== null) {
    reasons.push({ kind: 'citation', tier: cited })
    if (cited !== 'needs-work') tier = higher(tier, 'supported')
  }

  const dated = (ledger?.passes ?? []).flatMap((pass, order): DatedPass[] =>
    pass.current && pass.at !== null && permittedPass(pass) ? [{ pass, at: pass.at, order }] : [],
  )
  const edit = latest(
    dated.filter(({ pass }) => pass.agent === 'editor' && pass.status === 'pending'),
  )
  const lastReviewOrEdit = latest(
    dated.filter(({ pass }) => pass.agent === 'editor' || pass.agent === 'reviewer'),
  )
  // An edit after the last adversarial review voids it as a gate.
  const review = latest(
    dated.filter(
      (entry) =>
        ADVERSARIAL_AGENTS.has(entry.pass.agent) &&
        entry.pass.status === 'verified' &&
        (edit === null || after(entry, edit)),
    ),
  )
  if (strong && review !== null) {
    tier = 'solid'
    reasons.push({ kind: 'adversarial-review', agent: review.pass.agent, at: review.at })
  }

  const verdict = latest(dated.filter(({ pass }) => pass.agent !== 'editor'))
  if (verdict !== null && DISPUTED_STATUSES.has(verdict.pass.status)) {
    tier = 'needs-work'
    overlays.push('disputed')
    reasons.push({
      kind: 'disputed',
      agent: verdict.pass.agent,
      status: verdict.pass.status,
      at: verdict.at,
    })
  }
  if (lastReviewOrEdit !== null && lastReviewOrEdit === edit) {
    overlays.push('edited')
    reasons.push({ kind: 'edited', at: lastReviewOrEdit.at })
  }
  return { tier, overlays, reasons }
}

/** How many claims stand at each tier: a note's trust, never averaged. */
export function wikiTrustDistribution(
  trusts: readonly Pick<WikiClaimTrust, 'tier'>[],
): Readonly<Record<WikiTrustTier, number>> {
  const counts: Record<WikiTrustTier, number> = { solid: 0, supported: 0, 'needs-work': 0 }
  for (const { tier } of trusts) counts[tier] += 1
  return counts
}
