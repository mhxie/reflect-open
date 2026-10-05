import { describe, expect, it } from 'vitest'
import { aiSummaryOwner, AI_SUMMARY_MAX_CHARS, freshAiSummary } from './ai-summary.ts'
import { noteBodyHash } from './body-hash.ts'
import { splitFrontmatter, upsertFrontmatter } from './frontmatter.ts'
import { parseNote } from './extract.ts'

const BODY = '# Plan\n\nShip the summary column before the beta.\n'

function frontmatterOf(source: string): ReturnType<typeof parseNote>['frontmatter'] {
  return parseNote({ path: 'notes/plan.md', source }).frontmatter
}

describe('freshAiSummary', () => {
  it('returns the summary while its hash matches the body', () => {
    const source = upsertFrontmatter(BODY, {
      aiSummary: { text: 'Shipping plan for the beta.', hash: noteBodyHash(BODY) },
    })
    expect(freshAiSummary(frontmatterOf(source), splitFrontmatter(source).body)).toBe(
      'Shipping plan for the beta.',
    )
  })

  it('returns null once the body moves on', () => {
    const source = upsertFrontmatter(BODY, {
      aiSummary: { text: 'Shipping plan for the beta.', hash: noteBodyHash(BODY) },
    })
    const edited = `${source}One more line.\n`
    expect(freshAiSummary(frontmatterOf(edited), splitFrontmatter(edited).body)).toBeNull()
  })

  it('collapses whitespace and caps a hand-edited summary', () => {
    const long = `${'word '.repeat(80)}\n\nend`
    const source = upsertFrontmatter(BODY, {
      aiSummary: { text: long, hash: noteBodyHash(BODY) },
    })
    const preview = freshAiSummary(frontmatterOf(source), BODY)
    expect(preview).not.toContain('\n')
    expect(preview!.length).toBeLessThanOrEqual(AI_SUMMARY_MAX_CHARS + 1)
    expect(preview!.endsWith('…')).toBe(true)
  })

  it('ignores an empty summary and a block of another shape', () => {
    const empty = upsertFrontmatter(BODY, { aiSummary: { text: '  ', hash: noteBodyHash(BODY) } })
    expect(freshAiSummary(frontmatterOf(empty), BODY)).toBeNull()
    const foreign = upsertFrontmatter(BODY, { aiSummary: 'my own words' })
    expect(freshAiSummary(frontmatterOf(foreign), BODY)).toBeNull()
  })

  it('writing the block leaves the body hash unchanged', () => {
    for (const body of [BODY, '\nLeading blank line\n', 'no trailing newline']) {
      const written = upsertFrontmatter(body, { aiSummary: { text: 'x', hash: 'h' } })
      expect(noteBodyHash(splitFrontmatter(written).body)).toBe(noteBodyHash(body))
    }
  })
})

describe('aiSummaryOwner', () => {
  it('is none without the key', () => {
    expect(aiSummaryOwner(BODY)).toBe('none')
    expect(aiSummaryOwner(upsertFrontmatter(BODY, { pinned: true }))).toBe('none')
  })

  it('is managed for a block of the summary shape', () => {
    const source = upsertFrontmatter(BODY, { aiSummary: { text: 'x', hash: '0123' } })
    expect(aiSummaryOwner(source)).toBe('managed')
  })

  it('is foreign for any other value, or frontmatter that does not load', () => {
    expect(aiSummaryOwner(upsertFrontmatter(BODY, { aiSummary: 'mine' }))).toBe('foreign')
    expect(aiSummaryOwner(upsertFrontmatter(BODY, { aiSummary: { text: 'x' } }))).toBe('foreign')
    expect(aiSummaryOwner(`---\n[broken\n---\n${BODY}`)).toBe('foreign')
  })
})
