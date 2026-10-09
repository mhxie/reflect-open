import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { DEFAULT_SETTINGS } from '../settings/schema.ts'
import {
  DEFAULT_WIKI_TRUST_REPORT_PATH,
  isWikiTrustReportPath,
  normalizeWikiTrustReportPath,
  parseWikiTrustReport,
  wikiClaimStanding,
  wikiClaimTextSha256,
  wikiTrustReportJsonSchema,
  type WikiTrustReport,
} from './trust-report.ts'

const example = readFileSync(
  new URL('../../../../fixtures/wiki-trust-report.example.json', import.meta.url),
  'utf8',
)
const NOTE = 'wiki/cognition/Anchoring effect.md'
const C1_TEXT =
  'Numerical estimates shift toward an initial value, even when that value is plainly arbitrary.'

function exampleReport(): WikiTrustReport {
  const parsed = parseWikiTrustReport(example)
  if (!parsed.ok) throw new Error(parsed.error)
  return parsed.report
}

function withClaim(claim: unknown): string {
  const json: Record<string, unknown> = JSON.parse(example)
  return JSON.stringify({ ...json, notes: { [NOTE]: { claims: { c1: claim } } } })
}

describe('parseWikiTrustReport', () => {
  it('reads the documented example', () => {
    const parsed = parseWikiTrustReport(example)
    expect(parsed.ok && parsed.ignored).toBe(0)
    const report = exampleReport()
    expect(report.harness).toEqual({ name: 'example-harness', version: '1.0.0' })
    expect(report.sourceThreshold).toBe(0.6)
    expect(report.notes.get(NOTE)?.claims.get('c5')).toMatchObject({
      tier: 'needs-work',
      overlays: ['disputed'],
      next: 'Adding a primary source would make it Supported.',
    })
    expect(report.sources.get('host:en.wikipedia.org')).toMatchObject({
      weight: 0.41,
      trusted: false,
      url: null,
    })
  })

  it('refuses another format or version, naming the field', () => {
    const json: Record<string, unknown> = JSON.parse(example)
    expect(parseWikiTrustReport(JSON.stringify({ ...json, version: 2 }))).toEqual({
      ok: false,
      error: 'The trust report does not match reflect-wiki-trust version 1 at version.',
    })
    expect(parseWikiTrustReport(JSON.stringify({ ...json, format: 'other' })).ok).toBe(false)
    expect(parseWikiTrustReport('{').ok).toBe(false)
  })

  it('drops a claim with a malformed id alone, keeping its valid siblings', () => {
    const json: Record<string, unknown> = JSON.parse(example)
    const notes = json['notes'] as Record<string, { claims: Record<string, unknown> }>
    const claims = notes[NOTE]!.claims
    const parsed = parseWikiTrustReport(
      JSON.stringify({ ...json, notes: { [NOTE]: { claims: { ...claims, c0: claims['c1'] } } } }),
    )
    expect(parsed.ok && parsed.ignored).toBe(1)
    expect(parsed.ok && [...parsed.report.notes.get(NOTE)!.claims.keys()]).toEqual(['c1', 'c5'])
  })

  it('matches note keys whatever Unicode form the harness wrote', () => {
    const json: Record<string, unknown> = JSON.parse(example)
    const notes = json['notes'] as Record<string, unknown>
    const decomposed = 'wiki/Cafe\u{301}.md'
    const parsed = parseWikiTrustReport(
      JSON.stringify({ ...json, notes: { [decomposed]: notes[NOTE] } }),
    )
    if (!parsed.ok) throw new Error(parsed.error)
    expect(wikiClaimStanding(parsed.report, 'wiki/Caf\u{E9}.md', 'c1', 'a'.repeat(64)).state).toBe(
      'changed',
    )
  })

  it('drops and counts a malformed entry without failing the report', () => {
    const parsed = parseWikiTrustReport(withClaim({ tier: 'excellent' }))
    expect(parsed.ok && parsed.ignored).toBe(1)
    expect(parsed.ok && parsed.report.notes.get(NOTE)?.claims.size).toBe(0)
  })

  it('reads null optional fields as absent', () => {
    const parsed = parseWikiTrustReport(
      withClaim({
        tier: 'supported',
        overlays: null,
        text_sha256: 'a'.repeat(64),
        evaluated_at: '2026-10-08',
        reasons: null,
        next: null,
        sources: null,
      }),
    )
    expect(parsed.ok && parsed.report.notes.get(NOTE)?.claims.get('c1')).toMatchObject({
      overlays: [],
      reasons: [],
      next: null,
      sources: [],
    })
  })

  it('keeps known overlays and ignores ones this build does not show', () => {
    const parsed = parseWikiTrustReport(
      withClaim({
        tier: 'supported',
        overlays: ['edited', 'novel-overlay'],
        text_sha256: 'a'.repeat(64),
        evaluated_at: '2026-10-08',
      }),
    )
    expect(parsed.ok && parsed.report.notes.get(NOTE)?.claims.get('c1')?.overlays).toEqual([
      'edited',
    ])
  })

  it('refuses a source weight outside 0 to 1', () => {
    const json: Record<string, unknown> = JSON.parse(example)
    const parsed = parseWikiTrustReport(
      JSON.stringify({ ...json, sources: { x: { label: 'X', weight: 3, trusted: true } } }),
    )
    expect(parsed.ok && parsed.ignored).toBe(1)
  })
})

describe('wikiClaimStanding', () => {
  it('is current for the text the verdict was computed for, and changed otherwise', async () => {
    const report = exampleReport()
    expect(wikiClaimStanding(report, NOTE, 'c1', await wikiClaimTextSha256(C1_TEXT)).state).toBe(
      'current',
    )
    expect(
      wikiClaimStanding(report, NOTE, 'c1', await wikiClaimTextSha256(`${C1_TEXT} Edited.`)).state,
    ).toBe('changed')
    expect(wikiClaimStanding(report, NOTE, 'c9', 'a'.repeat(64)).state).toBe('unevaluated')
    expect(wikiClaimStanding(report, 'wiki/Other.md', 'c1', 'a'.repeat(64)).state).toBe(
      'unevaluated',
    )
  })

  it('hashes UTF-8 bytes as lowercase hex, reading CRLF and CR as LF', async () => {
    expect(await wikiClaimTextSha256('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
    const lf = await wikiClaimTextSha256('a\nb\nc')
    expect(await wikiClaimTextSha256('a\r\nb\rc')).toBe(lf)
  })
})

describe('isWikiTrustReportPath', () => {
  it('matches the corpus the Rust reader runs', () => {
    const corpus = z
      .object({
        cases: z.array(z.object({ path: z.string(), valid: z.boolean() })),
        default: z.string(),
        settings_key: z.string(),
      })
      .parse(
        JSON.parse(
          readFileSync(
            new URL('../../../../fixtures/wiki-trust-report-paths.json', import.meta.url),
            'utf8',
          ),
        ),
      )
    for (const { path, valid } of corpus.cases) {
      expect(isWikiTrustReportPath(path), path).toBe(valid)
    }
    expect(DEFAULT_WIKI_TRUST_REPORT_PATH).toBe(corpus.default)
    // The CLI reads the configured path from settings under this key.
    expect(DEFAULT_SETTINGS).toHaveProperty(corpus.settings_key, corpus.default)
  })
})

describe('normalizeWikiTrustReportPath', () => {
  it('accepts graph-relative JSON paths, hidden folders included', () => {
    expect(normalizeWikiTrustReportPath(' ./.harness/wiki-trust.json ')).toBe(
      '.harness/wiki-trust.json',
    )
    expect(normalizeWikiTrustReportPath('_meta/wiki-trust.JSON')).toBe('_meta/wiki-trust.JSON')
  })

  it('refuses paths the reader would refuse', () => {
    for (const path of [
      '',
      '/abs.json',
      '../out.json',
      'a//b.json',
      String.raw`a\b.json`,
      '.reflect/x.json',
      '.Git/x.json',
      'notes/x.md',
    ]) {
      expect(normalizeWikiTrustReportPath(path), path).toBeNull()
    }
  })
})

describe('wikiTrustReportJsonSchema', () => {
  it('matches the published schema file', () => {
    const published: unknown = JSON.parse(
      readFileSync(
        new URL('../../../../docs/wiki-trust-report.schema.json', import.meta.url),
        'utf8',
      ),
    )
    expect(published).toEqual(wikiTrustReportJsonSchema())
  })
})
