/**
 * The wiki trust report (Plan 30): the one interface between Reflect and an
 * agent harness's trust engine. A harness (atelier, or any other) evaluates
 * claims and sources however it likes and writes one JSON file into the
 * graph; Reflect validates it, checks each verdict against the claim text it
 * was computed for, and displays it. Reflect never computes a tier, score,
 * rank, or source weight. The format is specified in
 * `docs/wiki-trust-harness.md`; `wikiTrustReportJsonSchema` is its JSON Schema.
 */

import { z } from 'zod'

/** The report's `format` value, so an unrelated JSON file is never read as one. */
export const WIKI_TRUST_REPORT_FORMAT = 'reflect-wiki-trust'

/** The report version this build reads. */
export const WIKI_TRUST_REPORT_VERSION = 1

/** Where a harness writes the report unless the user configures another path. */
export const DEFAULT_WIKI_TRUST_REPORT_PATH = '.harness/wiki-trust.json'

/** How claim trust appears while reading: three styles, or not at all. */
export const WIKI_TRUST_DISPLAYS = ['inline', 'margin', 'on-demand', 'off'] as const

/** The chosen reading style (see {@link WIKI_TRUST_DISPLAYS}). */
export type WikiTrustDisplay = (typeof WIKI_TRUST_DISPLAYS)[number]

/**
 * A typed report path as a graph-relative path, or null when it cannot name
 * one: trimmed, a leading `./` dropped, forward slashes only, no empty, `.`,
 * or `..` segment, outside `.reflect/` and `.git/`, and ending in `.json`.
 * Mirrors the Rust reader's rules so Settings can say why before a read fails.
 */
export function normalizeWikiTrustReportPath(input: string): string | null {
  const path = input.trim().replace(/^\.\//, '')
  if (path === '' || path.includes('\\') || path.startsWith('/')) return null
  const segments = path.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return null
  const first = segments[0]!.toLowerCase()
  if (first === '.reflect' || first === '.git') return null
  return path.toLowerCase().endsWith('.json') ? path : null
}

/** How well a claim stands, strongest first, as the harness judged it. */
export type WikiTrustTier = 'solid' | 'supported' | 'needs-work'

/** Review states shown beside the tier. */
export type WikiTrustOverlay = 'disputed' | 'edited'

const TIERS = ['solid', 'supported', 'needs-work'] as const
const OVERLAYS: ReadonlySet<string> = new Set<WikiTrustOverlay>(['disputed', 'edited'])

/** One fact behind a verdict, as the harness wrote it. */
export interface WikiTrustReason {
  readonly text: string
  /** The harness's category for the reason, for styling; free-form. */
  readonly kind: string | null
}

/** The harness's verdict on one claim. */
export interface WikiClaimVerdict {
  readonly tier: WikiTrustTier
  readonly overlays: readonly WikiTrustOverlay[]
  /** The claim text the verdict is for: SHA-256 of its UTF-8 bytes, lowercase hex. */
  readonly textSha256: string
  /** The day the harness evaluated the claim (`YYYY-MM-DD`). */
  readonly evaluatedAt: string
  readonly score: number | null
  readonly reasons: readonly WikiTrustReason[]
  /** What would raise the tier, when the harness says. */
  readonly next: string | null
  /** Origin keys of the sources the verdict rests on (see `sources`). */
  readonly sources: readonly string[]
}

/** The harness's standing for one source. */
export interface WikiSourceStanding {
  readonly label: string
  /** Normalized across the wiki, 0 to 1. */
  readonly weight: number
  /** Whether the weight clears the harness's threshold. */
  readonly trusted: boolean
  readonly url: string | null
  readonly reasons: readonly WikiTrustReason[]
}

/** One note's entry in the report. */
export interface WikiNoteTrust {
  /** The harness's ordering rank; higher ranks first. */
  readonly rank: number | null
  readonly claims: ReadonlyMap<string, WikiClaimVerdict>
}

/** A validated report. */
export interface WikiTrustReport {
  readonly generatedAt: string
  readonly harness: { readonly name: string; readonly version: string | null }
  /** Entries by graph-relative note path. */
  readonly notes: ReadonlyMap<string, WikiNoteTrust>
  /** Standings by origin key. */
  readonly sources: ReadonlyMap<string, WikiSourceStanding>
  /** The weight a source needs to be trusted, when the harness publishes it. */
  readonly sourceThreshold: number | null
}

/** The result of reading a report file. */
export type WikiTrustReportParse =
  | {
      readonly ok: true
      readonly report: WikiTrustReport
      /** Entries dropped because they did not validate. */
      readonly ignored: number
    }
  | { readonly ok: false; readonly error: string }

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/)
const claimIdSchema = z.string().regex(/^c[1-9]\d*$/)

const reasonSchema = z.object({
  text: z.string().min(1),
  kind: z.string().optional(),
})

const claimSchema = z.object({
  tier: z.enum(TIERS),
  overlays: z.array(z.string()).optional(),
  text_sha256: sha256Hex,
  evaluated_at: isoDay,
  score: z.number().finite().optional(),
  reasons: z.array(reasonSchema).optional(),
  next: z.string().optional(),
  sources: z.array(z.string()).optional(),
})

const noteSchema = z.object({
  rank: z.number().finite().optional(),
  claims: z.record(claimIdSchema, z.unknown()),
})

const sourceSchema = z.object({
  label: z.string().min(1),
  weight: z.number().min(0).max(1),
  trusted: z.boolean(),
  url: z.string().optional(),
  reasons: z.array(reasonSchema).optional(),
})

const envelopeSchema = z.object({
  format: z.literal(WIKI_TRUST_REPORT_FORMAT),
  version: z.literal(WIKI_TRUST_REPORT_VERSION),
  generated_at: z.string().min(1),
  harness: z.object({ name: z.string().min(1), version: z.string().optional() }),
  notes: z.record(z.string(), z.unknown()),
  sources: z.record(z.string(), z.unknown()).optional(),
  source_threshold: z.number().min(0).max(1).optional(),
})

/**
 * The whole report as one schema, for the published JSON Schema. Reading
 * uses the same parts entry by entry, so one bad claim drops alone.
 */
const reportSchema = envelopeSchema.extend({
  notes: z.record(z.string(), noteSchema.extend({ claims: z.record(claimIdSchema, claimSchema) })),
  sources: z.record(z.string(), sourceSchema).optional(),
})

/** The report format as a JSON Schema document, for harness authors. */
export function wikiTrustReportJsonSchema(): Record<string, unknown> {
  return { title: 'Reflect wiki trust report', ...z.toJSONSchema(reportSchema, { io: 'input' }) }
}

function reasonsOf(reasons: z.infer<typeof reasonSchema>[] | undefined): WikiTrustReason[] {
  return (reasons ?? []).map((reason) => ({ text: reason.text, kind: reason.kind ?? null }))
}

function isOverlay(value: string): value is WikiTrustOverlay {
  return OVERLAYS.has(value)
}

/**
 * Validate a report's text. The envelope must match this build's format and
 * version; a note, claim, or source entry that does not validate is dropped
 * and counted, so one malformed entry never blanks the whole wiki.
 */
export function parseWikiTrustReport(text: string): WikiTrustReportParse {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return { ok: false, error: 'The trust report is not valid JSON.' }
  }
  const envelope = envelopeSchema.safeParse(json)
  if (!envelope.success) {
    const issue = envelope.error.issues[0]
    const where =
      issue === undefined || issue.path.length === 0 ? '' : ` at ${issue.path.join('.')}`
    return {
      ok: false,
      error: `The trust report does not match ${WIKI_TRUST_REPORT_FORMAT} version ${WIKI_TRUST_REPORT_VERSION}${where}.`,
    }
  }
  let ignored = 0
  const notes = new Map<string, WikiNoteTrust>()
  for (const [path, value] of Object.entries(envelope.data.notes)) {
    const note = noteSchema.safeParse(value)
    if (!note.success) {
      ignored += 1
      continue
    }
    const claims = new Map<string, WikiClaimVerdict>()
    for (const [id, claimValue] of Object.entries(note.data.claims)) {
      const claim = claimSchema.safeParse(claimValue)
      if (!claim.success) {
        ignored += 1
        continue
      }
      claims.set(id, {
        tier: claim.data.tier,
        overlays: (claim.data.overlays ?? []).filter(isOverlay),
        textSha256: claim.data.text_sha256,
        evaluatedAt: claim.data.evaluated_at,
        score: claim.data.score ?? null,
        reasons: reasonsOf(claim.data.reasons),
        next: claim.data.next ?? null,
        sources: claim.data.sources ?? [],
      })
    }
    notes.set(path, { rank: note.data.rank ?? null, claims })
  }
  const sources = new Map<string, WikiSourceStanding>()
  for (const [origin, value] of Object.entries(envelope.data.sources ?? {})) {
    const source = sourceSchema.safeParse(value)
    if (!source.success) {
      ignored += 1
      continue
    }
    sources.set(origin, {
      label: source.data.label,
      weight: source.data.weight,
      trusted: source.data.trusted,
      url: source.data.url ?? null,
      reasons: reasonsOf(source.data.reasons),
    })
  }
  return {
    ok: true,
    ignored,
    report: {
      generatedAt: envelope.data.generated_at,
      harness: { name: envelope.data.harness.name, version: envelope.data.harness.version ?? null },
      notes,
      sources,
      sourceThreshold: envelope.data.source_threshold ?? null,
    },
  }
}

/**
 * The hash a verdict is keyed to: SHA-256 of the claim text's UTF-8 bytes
 * (the range between its markers, or a legacy claim's body), lowercase hex.
 */
export async function wikiClaimTextSha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Where a claim stands in the report: `current` when the verdict is for its
 * present text, `changed` when the text moved on since the harness evaluated
 * it (the verdict is kept for reference, not shown as current), and
 * `unevaluated` when the report has no verdict for it.
 */
export type WikiClaimStanding =
  | { readonly state: 'current'; readonly verdict: WikiClaimVerdict }
  | { readonly state: 'changed'; readonly verdict: WikiClaimVerdict }
  | { readonly state: 'unevaluated' }

/** The standing of claim `claimId` in the note at `path`, whose text hashes to `textSha256`. */
export function wikiClaimStanding(
  report: WikiTrustReport,
  path: string,
  claimId: string,
  textSha256: string,
): WikiClaimStanding {
  const verdict = report.notes.get(path)?.claims.get(claimId)
  if (verdict === undefined) return { state: 'unevaluated' }
  return verdict.textSha256 === textSha256
    ? { state: 'current', verdict }
    : { state: 'changed', verdict }
}

/** How many of a note's standings fall in each tier, plus the changed and unevaluated. */
export interface WikiTrustCounts {
  readonly solid: number
  readonly supported: number
  readonly needsWork: number
  readonly disputed: number
  readonly edited: number
  /** Claims whose text changed since evaluation, or that have no verdict. */
  readonly pending: number
}

/** Count standings for an article summary or a Wiki screen row; display only. */
export function wikiTrustCounts(standings: readonly WikiClaimStanding[]): WikiTrustCounts {
  let solid = 0
  let supported = 0
  let needsWork = 0
  let disputed = 0
  let edited = 0
  let pending = 0
  for (const standing of standings) {
    if (standing.state !== 'current') {
      pending += 1
      continue
    }
    const { tier, overlays } = standing.verdict
    if (tier === 'solid') solid += 1
    else if (tier === 'supported') supported += 1
    else needsWork += 1
    if (overlays.includes('disputed')) disputed += 1
    if (overlays.includes('edited')) edited += 1
  }
  return { solid, supported, needsWork, disputed, edited, pending }
}
