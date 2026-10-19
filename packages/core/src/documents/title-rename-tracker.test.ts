import { describe, expect, it } from 'vitest'
import { createTestClockService } from '../testing/clock.ts'
import { createTitleRenameTracker, type TitleRename } from './title-rename-tracker.ts'

function tracked(options?: { canFire?: () => boolean }) {
  const renames: TitleRename[] = []
  const clock = createTestClockService()
  const tracker = createTitleRenameTracker({
    path: 'notes/x.md',
    quietMs: 5000,
    onRename: (rename) => {
      renames.push(rename)
    },
    canFire: options?.canFire,
    clock,
  })
  return { tracker, renames, clock }
}

describe('createTitleRenameTracker', () => {
  it('fires after the quiet period once a saved title differs from baseline', async () => {
    const { tracker, renames, clock } = tracked()
    tracker.baseline('# Old Title\n')
    tracker.saved('# New Title\n')
    expect(renames).toEqual([])
    await clock.advance(5000)
    expect(renames).toEqual([{ from: 'Old Title', to: 'New Title', previousAutoAlias: null }])
  })

  it('re-arms on every save: intermediate titles never fire', async () => {
    const { tracker, renames, clock } = tracked()
    tracker.baseline('# My Note\n')
    tracker.saved('# My N\n') // mid-edit garbage state
    await clock.advance(4000)
    tracker.saved('# My Notebook\n')
    await clock.advance(4999)
    expect(renames).toEqual([])
    await clock.advance(1)
    expect(renames).toHaveLength(1)
    expect(renames[0]).toMatchObject({ from: 'My Note', to: 'My Notebook' })
  })

  it('settle fires the pending rename immediately', () => {
    const { tracker, renames } = tracked()
    tracker.baseline('# A\n')
    tracker.saved('# B\n')
    tracker.settle()
    expect(renames).toHaveLength(1)
    tracker.settle() // nothing pending — no double fire
    expect(renames).toHaveLength(1)
  })

  it('a reverted title clears the pending rename', async () => {
    const { tracker, renames, clock } = tracked()
    tracker.baseline('# A\n')
    tracker.saved('# B\n')
    tracker.saved('# A\n') // changed their mind
    await clock.advance(10_000)
    tracker.settle()
    expect(renames).toEqual([])
  })

  it('a pure case change is not a rename (resolution is case-insensitive)', async () => {
    const { tracker, renames, clock } = tracked()
    tracker.baseline('# my note\n')
    tracker.saved('# My Note\n')
    await clock.advance(10_000)
    expect(renames).toEqual([])
  })

  it('external content re-baselines without firing and resets the alias chain', async () => {
    const { tracker, renames, clock } = tracked()
    tracker.baseline('# A\n')
    tracker.saved('# B\n')
    tracker.baseline('# C\n') // external edit adopted mid-quiet-period
    await clock.advance(10_000)
    expect(renames).toEqual([])
    tracker.saved('# D\n')
    tracker.settle()
    expect(renames).toEqual([{ from: 'C', to: 'D', previousAutoAlias: null }])
  })

  it('chained renames carry the previous auto-alias for pruning', () => {
    const { tracker, renames } = tracked()
    tracker.baseline('# First\n')
    tracker.saved('# Second\n')
    tracker.settle()
    tracker.saved('# Third\n')
    tracker.settle()
    expect(renames).toEqual([
      { from: 'First', to: 'Second', previousAutoAlias: null },
      { from: 'Second', to: 'Third', previousAutoAlias: 'First' },
    ])
  })

  it('derives the title from frontmatter when the note has no H1', () => {
    const { tracker, renames } = tracked()
    tracker.baseline('---\ntitle: Real Title\n---\nBody\n')
    tracker.saved('---\ntitle: Renamed\n---\nBody\n')
    tracker.settle()
    expect(renames[0]).toMatchObject({ from: 'Real Title', to: 'Renamed' })
  })

  it('an H1 typed under a frontmatter title this session renames nothing', async () => {
    // It may be a section heading: only an H1 the note had when loaded counts.
    const { tracker, renames, clock } = tracked()
    tracker.baseline('---\ntitle: Paper\n---\nBody\n')
    tracker.saved('---\ntitle: Paper\n---\n# S\n\nBody\n')
    tracker.saved('---\ntitle: Paper\n---\n# Summary\n\nBody\n')
    await clock.advance(10_000)
    tracker.settle()
    expect(renames).toEqual([])
  })

  it('follows only the H1 while there is one, not a frontmatter change', async () => {
    const { tracker, renames, clock } = tracked()
    tracker.baseline('---\ntitle: A\n---\n# A\n')
    tracker.saved('---\ntitle: B\n---\n# A\n')
    await clock.advance(10_000)
    tracker.settle()
    expect(renames).toEqual([])
  })

  it('restore puts back the state before a rename that did not land', async () => {
    const { tracker, renames, clock } = tracked()
    tracker.baseline('---\ntitle: Canonical\n---\n# Original heading\n')
    tracker.saved('---\ntitle: Canonical\n---\n# New heading\n')
    tracker.settle()
    expect(renames).toHaveLength(1)
    tracker.restore()
    // Reverting the edit is not a rename…
    tracker.saved('---\ntitle: Canonical\n---\n# Original heading\n')
    await clock.advance(10_000)
    expect(renames).toHaveLength(1)
    // …and redoing it renames again, still at the start of the chain.
    tracker.saved('---\ntitle: Canonical\n---\n# New heading\n')
    tracker.settle()
    expect(renames[1]).toEqual({ from: 'Canonical', to: 'New heading', previousAutoAlias: null })
  })

  it('a blocked fire keeps the rename pending until the gate opens', async () => {
    let conflictParked = true
    const { tracker, renames, clock } = tracked({ canFire: () => !conflictParked })
    tracker.baseline('# A\n')
    tracker.saved('# B\n')
    tracker.settle() // blocked: conflict parked
    await clock.advance(10_000)
    expect(renames).toEqual([])

    conflictParked = false
    tracker.saved('# B\n') // "keep mine" re-saves the same title → re-arms
    await clock.advance(5000)
    expect(renames).toEqual([{ from: 'A', to: 'B', previousAutoAlias: null }])
  })

  it('an H1 edit under a frontmatter title renames from that title to the H1', async () => {
    // Links resolve against `title:`, so that is what they are rewritten from;
    // the rename then writes the new H1 into `title:`.
    const { tracker, renames, clock } = tracked()
    tracker.baseline('---\ntitle: Canonical\n---\n# Canonical\n')
    tracker.saved('---\ntitle: Canonical\n---\n# New Heading\n')
    expect(renames).toEqual([])
    await clock.advance(5000)
    expect(renames).toEqual([{ from: 'Canonical', to: 'New Heading', previousAutoAlias: null }])
    // Once `title:` follows, the next save is the settled state, not a rename back.
    tracker.saved('---\ntitle: New Heading\n---\n# New Heading\n')
    await clock.advance(10_000)
    expect(renames).toHaveLength(1)
  })

  it('an H1 that already differs from the frontmatter title renames only when edited', async () => {
    const { tracker, renames, clock } = tracked()
    tracker.baseline('---\ntitle: Paper Title\n---\n# Reading notes\n')
    // Editing the body leaves the title alone.
    tracker.saved('---\ntitle: Paper Title\n---\n# Reading notes\n\nMore.\n')
    await clock.advance(10_000)
    expect(renames).toEqual([])
    // A case-only touch to the H1 is not an edit of it.
    tracker.saved('---\ntitle: Paper Title\n---\n# Reading Notes\n')
    await clock.advance(10_000)
    expect(renames).toEqual([])
    tracker.saved('---\ntitle: Paper Title\n---\n# Notes on the paper\n')
    tracker.settle()
    expect(renames).toEqual([
      { from: 'Paper Title', to: 'Notes on the paper', previousAutoAlias: null },
    ])
  })

  it('the first authored title on an untitled note is a birth (from: null), settled like a rename', async () => {
    const { tracker, renames, clock } = tracked()
    tracker.baseline('') // fresh lazy note (⌘N): derived title is the filename
    tracker.saved('# My New\n') // intermediate typing state — must not fire
    tracker.saved('# My New Note\n')
    expect(renames).toEqual([]) // births settle through the quiet timer too
    await clock.advance(10_000)
    // No phantom rename from the ULID stem — a birth carries no `from` title.
    expect(renames).toEqual([{ from: null, to: 'My New Note', previousAutoAlias: null }])

    tracker.saved('# Renamed\n') // a real rename afterwards still works
    tracker.settle()
    expect(renames).toEqual([
      { from: null, to: 'My New Note', previousAutoAlias: null },
      { from: 'My New Note', to: 'Renamed', previousAutoAlias: null },
    ])
  })

  it('a birth pending at a settle point fires immediately', () => {
    const { tracker, renames } = tracked()
    tracker.baseline('')
    tracker.saved('# Named On The Way Out\n')
    tracker.settle() // teardown/blur before the quiet period elapses
    expect(renames).toEqual([{ from: null, to: 'Named On The Way Out', previousAutoAlias: null }])
  })

  it('a birth cleared back to untitled never fires', async () => {
    const { tracker, renames, clock } = tracked()
    tracker.baseline('')
    tracker.saved('# Oops\n')
    tracker.saved('no heading any more\n') // title deleted before it settled
    await clock.advance(10_000)
    tracker.settle()
    expect(renames).toEqual([])
  })

  it('removing the title mid-edit clears pending but keeps the baseline', async () => {
    const { tracker, renames, clock } = tracked()
    tracker.baseline('# A\n')
    tracker.saved('body only, heading deleted\n')
    await clock.advance(10_000)
    expect(renames).toEqual([]) // untitled is not a rename target
    tracker.saved('# B\n')
    tracker.settle()
    expect(renames).toEqual([{ from: 'A', to: 'B', previousAutoAlias: null }])
  })

  it('does nothing after dispose', async () => {
    const { tracker, renames, clock } = tracked()
    tracker.baseline('# A\n')
    tracker.saved('# B\n')
    tracker.dispose()
    await clock.advance(10_000)
    tracker.settle()
    expect(renames).toEqual([])
  })
})
