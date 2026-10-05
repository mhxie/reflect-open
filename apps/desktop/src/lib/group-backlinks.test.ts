import { describe, expect, it } from 'vitest'
import type { BacklinkContext } from '@reflect/core'
import { groupBacklinksBySource } from './group-backlinks.ts'

function row(
  sourcePath: string,
  snippet: string,
  posFrom: number,
  sourcePrivate = false,
): BacklinkContext {
  return {
    sourceHasConflict: false,
    sourcePath,
    sourceTitle: sourcePath,
    sourcePrivate,
    snippet,
    posFrom,
    tasks: [],
  }
}

describe('groupBacklinksBySource', () => {
  it('groups rows by source note, preserving order and per-link keys', () => {
    const groups = groupBacklinksBySource([
      row('notes/a.md', 'first [[t]]', 4),
      row('notes/a.md', 'second [[t]]', 40),
      row('notes/b.md', 'only [[t]]', 9),
    ])

    expect(groups).toEqual([
      {
        path: 'notes/a.md',
        title: 'notes/a.md',
        isPrivate: false,
        hasConflict: false,
        snippets: [
          { key: 'notes/a.md:4', text: 'first [[t]]', tasks: [] },
          { key: 'notes/a.md:40', text: 'second [[t]]', tasks: [] },
        ],
      },
      {
        path: 'notes/b.md',
        title: 'notes/b.md',
        isPrivate: false,
        hasConflict: false,
        snippets: [{ key: 'notes/b.md:9', text: 'only [[t]]', tasks: [] }],
      },
    ])
  })

  it('drops empty snippets but keeps the source group', () => {
    const groups = groupBacklinksBySource([row('notes/gone.md', '', 0, true)])
    expect(groups).toEqual([
      {
        path: 'notes/gone.md',
        title: 'notes/gone.md',
        isPrivate: true,
        hasConflict: false,
        snippets: [],
      },
    ])
  })

  it('makes a source private when any of its rows is', () => {
    const groups = groupBacklinksBySource([
      row('notes/a.md', 'first [[t]]', 4),
      row('notes/a.md', 'second [[t]]', 40, true),
      row('notes/b.md', 'only [[t]]', 9),
    ])
    expect(groups.map((group) => [group.path, group.isPrivate])).toEqual([
      ['notes/a.md', true],
      ['notes/b.md', false],
    ])
  })

  it('treats a row that leaves privacy unsaid as private', () => {
    const { sourcePrivate: _unsaid, ...unsaid } = row('notes/a.md', 'first [[t]]', 4)
    // Simulates a row from outside the typed query (a mocked or older bridge).
    const groups = groupBacklinksBySource([unsaid as BacklinkContext])
    expect(groups[0]?.isPrivate).toBe(true)
  })

  it('preserves conflict when any snippet from the source carries it', () => {
    const groups = groupBacklinksBySource([
      row('notes/a.md', 'first [[t]]', 4, true),
      { ...row('notes/a.md', 'second [[t]]', 40), sourceHasConflict: true },
      row('notes/b.md', 'only [[t]]', 9),
    ])
    expect(
      groups.map(({ path, isPrivate, hasConflict }) => ({ path, isPrivate, hasConflict })),
    ).toEqual([
      { path: 'notes/a.md', isPrivate: true, hasConflict: true },
      { path: 'notes/b.md', isPrivate: false, hasConflict: false },
    ])
  })
})
