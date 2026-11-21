import { describe, expect, it } from 'vitest'
import { NOTE_EMBED_PREVIEW_CHARS, noteEmbedExcerpt } from './note-embed-excerpt.ts'

const REPORT = [
  '# Daily Sweep',
  '',
  '## Coverage',
  '',
  'Bookkeeping.',
  '',
  '### Audit',
  '',
  '## Candidate signals',
  '',
  '- First finding.',
  '',
  '### Detail',
  '',
  'Nested.',
  '',
  '```md',
  '## Not a heading',
  '```',
  '',
  '## Rejected leads',
  '',
  'Later.',
].join('\n')

describe('noteEmbedExcerpt', () => {
  it('previews the named section under the note title, through its subsections', () => {
    const excerpt = noteEmbedExcerpt(REPORT, 'Candidate signals')
    expect(excerpt.startsWith('# Daily Sweep\n\n## Candidate signals\n\n- First finding.')).toBe(
      true,
    )
    expect(excerpt).toContain('### Detail')
    expect(excerpt).toContain('## Not a heading')
    expect(excerpt).not.toContain('Bookkeeping.')
    expect(excerpt).not.toContain('Rejected leads')
  })

  it('matches heading text loosely, by slug, and when percent-encoded', () => {
    for (const fragment of ['candidate  SIGNALS', 'candidate-signals', 'Candidate%20signals']) {
      expect(noteEmbedExcerpt(REPORT, fragment)).toContain('- First finding.')
    }
  })

  it('previews the start of the body without a usable heading fragment', () => {
    const start = REPORT.slice(0, NOTE_EMBED_PREVIEW_CHARS)
    for (const fragment of [null, '', '^c3', 'Missing', 'Not a heading']) {
      expect(noteEmbedExcerpt(REPORT, fragment)).toBe(start)
    }
  })

  it('keeps the bound, and does not repeat a title that is itself the section', () => {
    const long = `# Title\n\n## Long\n\n${'x'.repeat(NOTE_EMBED_PREVIEW_CHARS * 2)}`
    expect(noteEmbedExcerpt(long, 'Long')).toHaveLength(NOTE_EMBED_PREVIEW_CHARS)
    expect(noteEmbedExcerpt('# Title\n\nBody', 'Title')).toBe('# Title\n\nBody')
  })
})
