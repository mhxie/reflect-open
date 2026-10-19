import { describe, expect, it } from 'vitest'
import { INVALID_TAG_ERROR } from './note-tools-service.ts'
import { ASSET_UNAVAILABLE_ERROR } from './read-assets.ts'
import { toolResultSources } from './tool-result-sources.ts'

describe('toolResultSources', () => {
  const note = (path: string) => ({ path, title: path, content: 'body', truncated: false })

  it('names what each note tool read, successful entries only', () => {
    expect(
      toolResultSources('search_notes', { hits: [{ path: 'notes/a.md', title: 'A' }] }),
    ).toEqual({ notes: ['notes/a.md'], assets: [], searchSnapshots: [{ path: 'notes/a.md' }] })
    expect(
      toolResultSources('read_notes', {
        notes: [
          { ok: true, note: note('notes/a.md') },
          { ok: false, path: 'notes/missing.md', error: 'No note exists at this path.' },
        ],
      }),
    ).toEqual({ notes: ['notes/a.md'], assets: [] })
    expect(
      toolResultSources('read_assets', {
        assets: [
          { ok: true, asset: { path: 'assets/a.png', description: 'A chart.', truncated: false } },
          { ok: false, path: 'assets/b.png', error: ASSET_UNAVAILABLE_ERROR },
        ],
      }),
    ).toEqual({ notes: [], assets: ['assets/a.png'] })
    expect(
      toolResultSources('list_recent_notes', { ok: true, notes: [{ path: 'notes/a.md' }] }),
    ).toEqual({ notes: ['notes/a.md'], assets: [] })
    expect(
      toolResultSources('list_recent_notes', { ok: false, tag: '*', error: INVALID_TAG_ERROR }),
    ).toEqual({ notes: [], assets: [] })
    expect(
      toolResultSources('list_daily_notes', { days: [{ path: 'daily/2026-06-01.md' }] }),
    ).toEqual({ notes: ['daily/2026-06-01.md'], assets: [] })
  })

  it("keeps a search snapshot's attachment-text hash, refusing a malformed one", () => {
    const assetTextHash = 'a'.repeat(64)
    expect(
      toolResultSources('search_notes', { hits: [{ path: 'notes/a.md', assetTextHash }] }),
    ).toEqual({
      notes: ['notes/a.md'],
      assets: [],
      searchSnapshots: [{ path: 'notes/a.md', assetTextHash }],
    })
    expect(
      toolResultSources('search_notes', { hits: [{ path: 'notes/a.md', assetTextHash: 'nope' }] }),
    ).toBeNull()
  })

  it('reads the shapes older builds persisted', () => {
    expect(toolResultSources('read_note', { ok: true, note: note('notes/a.md') })).toEqual({
      notes: ['notes/a.md'],
      assets: [],
    })
    expect(toolResultSources('list_recent_notes', { notes: [{ path: 'notes/a.md' }] })).toEqual({
      notes: ['notes/a.md'],
      assets: [],
    })
  })

  it('returns null for an unknown tool or an output that does not parse', () => {
    expect(toolResultSources('summarize_notes', { notes: [] })).toBeNull()
    expect(toolResultSources('read_notes', { notes: 'notes/a.md' })).toBeNull()
    expect(toolResultSources('search_notes', 'notes/a.md')).toBeNull()
  })
})
