/**
 * The wiki trust report: the one interface between Reflect and an
 * agent harness's trust engine. A harness (atelier, or any other) evaluates
 * claims and sources however it likes and writes one JSON file into the
 * graph; Reflect validates it, checks each verdict against the claim text it
 * was computed for, and displays it. Reflect never computes a tier or a
 * source weight. The format is specified in
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
 * Whether `path` names a place a trust report may live: plain `/`-separated
 * segments (none empty, `.`, `..`, or holding a backslash), ending in `.json`, and
 * not under `.reflect/` or `.git/`. The same rules as the Rust reader's
 * (`reflect_graph_paths::is_wiki_trust_report_path`), checked against one
 * corpus, `fixtures/wiki-trust-report-paths.json`.
 */
export function isWikiTrustReportPath(path: string): boolean {
  const segments = path.split('/')
  const plain = segments.every(
    (segment) => segment !== '' && segment !== '.' && segment !== '..' && !/[\\:]/.test(segment),
  )
  const first = (segments[0] ?? '').toLowerCase()
  return plain && first !== '.reflect' && first !== '.git' && path.toLowerCase().endsWith('.json')
}

/** A typed report path, trimmed and without a leading `./`, or null when Reflect may not read it. */
export function normalizeWikiTrustReportPath(input: string): string | null {
  const path = input.trim().replace(/^\.\//, '')
  return isWikiTrustReportPath(path) ? path : null
}

/** How well a claim stands, strongest first, as the harness judged it. */
export type WikiTrustTier = 'solid' | 'supported' | 'needs-work'

/** Review states shown beside the tier. */
export type WikiTrustOverlay = 'disputed' | 'edited'

const TIERS = ['solid', 'supported', 'needs-work'] as const
const OVERLAYS: ReadonlySet<string> = new Set<WikiTrustOverlay>(['disputed', 'edited'])

/** One fact behind a verdict, as the harness wrote it for a reader. */
export interface WikiTrustReason {
  readonly text: string
}

/** The harness's verdict on one claim. */
export interface WikiClaimVerdict {
  readonly tier: WikiTrustTier
  readonly overlays: readonly WikiTrustOverlay[]
  /** The claim text the verdict is for: SHA-256 of its UTF-8 bytes, lowercase hex. */
  readonly textSha256: string
  /** The day the harness evaluated the claim (`YYYY-MM-DD`). */
  readonly evaluatedAt: string
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

const reasonSchema = z.object({ text: z.string().min(1) })

const claimSchema = z.object({
  tier: z.enum(TIERS),
  overlays: z.array(z.string()).nullish(),
  text_sha256: sha256Hex,
  evaluated_at: isoDay,
  reasons: z.array(reasonSchema).nullish(),
  next: z.string().nullish(),
  sources: z.array(z.string()).nullish(),
})

const noteSchema = z.object({
  // Keys are checked one by one below, so a bad id drops only its own entry.
  claims: z.record(z.string(), z.unknown()),
})

const sourceSchema = z.object({
  label: z.string().min(1),
  weight: z.number().min(0).max(1),
  trusted: z.boolean(),
  url: z.string().nullish(),
  reasons: z.array(reasonSchema).nullish(),
})

const envelopeSchema = z.object({
  format: z.literal(WIKI_TRUST_REPORT_FORMAT),
  version: z.literal(WIKI_TRUST_REPORT_VERSION),
  generated_at: z.string().min(1),
  harness: z.object({ name: z.string().min(1), version: z.string().nullish() }),
  notes: z.record(z.string(), z.unknown()),
  sources: z.record(z.string(), z.unknown()).nullish(),
  source_threshold: z.number().min(0).max(1).nullish(),
})

/**
 * The whole report as one schema, for the published JSON Schema. Reading
 * uses the same parts entry by entry, so one bad claim drops alone.
 */
const reportSchema = envelopeSchema.extend({
  notes: z.record(z.string(), noteSchema.extend({ claims: z.record(claimIdSchema, claimSchema) })),
  sources: z.record(z.string(), sourceSchema).nullish(),
})

/** The report format as a JSON Schema document, for harness authors. */
export function wikiTrustReportJsonSchema(): Record<string, unknown> {
  return { title: 'Reflect wiki trust report', ...z.toJSONSchema(reportSchema, { io: 'input' }) }
}

function reasonsOf(reasons: z.infer<typeof reasonSchema>[] | null | undefined): WikiTrustReason[] {
  return (reasons ?? []).map((reason) => ({ text: reason.text }))
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
      if (!claimIdSchema.safeParse(id).success || !claim.success) {
        ignored += 1
        continue
      }
      claims.set(id, {
        tier: claim.data.tier,
        overlays: (claim.data.overlays ?? []).filter(isOverlay),
        textSha256: claim.data.text_sha256,
        evaluatedAt: claim.data.evaluated_at,
        reasons: reasonsOf(claim.data.reasons),
        next: claim.data.next ?? null,
        sources: claim.data.sources ?? [],
      })
    }
    notes.set(path.normalize('NFC'), { claims })
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
 * The hash a verdict is keyed to: SHA-256, lowercase hex, of the UTF-8 bytes
 * of the claim text between its markers, with CRLF and lone CR read as LF
 * (Reflect holds notes with LF line endings whatever the file uses).
 */
export async function wikiClaimTextSha256(text: string): Promise<string> {
  const lines = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(lines))
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
  const verdict = report.notes.get(path.normalize('NFC'))?.claims.get(claimId)
  if (verdict === undefined) return { state: 'unevaluated' }
  return verdict.textSha256 === textSha256
    ? { state: 'current', verdict }
    : { state: 'changed', verdict }
}
