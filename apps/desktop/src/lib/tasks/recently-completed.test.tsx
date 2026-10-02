import { act } from 'react'
import { cleanup, renderHook } from 'vitest-browser-react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { OpenTask, TaskSnapshot } from '@reflect/core'
import { makeOpenTask as task } from './open-task-fixture.ts'
import { getTaskKey } from './task-identity.ts'
import {
  archiveRecentlyCompleted,
  forgetRecentlyCompleted,
  hasRecentlyCompleted,
  markRecentlyCompleted,
  reconcileRecentlyCompleted,
  relocateRecentlyCompleted,
  resetRecentlyCompleted,
  useRecentlyCompleted,
} from './recently-completed.ts'

/** A struck task as the note holds it: checked, unless a case says otherwise. */
function snapshot(astPath: number[], markdown: string, checked = true): TaskSnapshot {
  return { astPath, markdown, breadcrumbs: [], checked }
}

beforeEach(() => resetRecentlyCompleted())
afterEach(() => {
  cleanup()
  resetRecentlyCompleted()
})

describe('recently-completed', () => {
  it('keeps session completions showing, as checked', async () => {
    const { result } = await renderHook(() => useRecentlyCompleted('/g', undefined))
    expect(result.current).toEqual([])

    act(() => markRecentlyCompleted('/g', [task({ notePath: 'a.md', astPath: [2] })]))
    expect(result.current).toHaveLength(1)
    // `checked` matches disk: these rows outlive the reindex, so a stale
    // `false` would later fail a reopen/edit/delete write-back.
    expect(result.current[0]!.checked).toBe(true)
  })

  it('dedupes by task key', async () => {
    const { result } = await renderHook(() => useRecentlyCompleted('/g', undefined))
    const taskRow = task({ notePath: 'a.md', astPath: [2] })
    act(() => markRecentlyCompleted('/g', [taskRow]))
    act(() => markRecentlyCompleted('/g', [taskRow]))
    expect(result.current).toHaveLength(1)
  })

  it('forgets dropped keys and clears on archive', async () => {
    const { result } = await renderHook(() => useRecentlyCompleted('/g', undefined))
    act(() =>
      markRecentlyCompleted('/g', [
        task({ notePath: 'a.md', astPath: [2] }),
        task({ notePath: 'b.md', astPath: [2] }),
      ]),
    )
    act(() => forgetRecentlyCompleted('/g', ['a.md:[2]']))
    expect(result.current.map((row) => row.notePath)).toEqual(['b.md'])

    act(() => archiveRecentlyCompleted('/g'))
    expect(result.current).toEqual([])
  })

  it('relocates struck rows a note write moved', async () => {
    const { result } = await renderHook(() => useRecentlyCompleted('/g', undefined))
    act(() =>
      markRecentlyCompleted('/g', [
        task({ notePath: 'a.md', astPath: [4], markdown: 'done' }),
        task({ notePath: 'b.md', astPath: [4], markdown: 'other' }),
      ]),
    )

    act(() =>
      relocateRecentlyCompleted('/g', 'a.md', [
        { from: snapshot([4], 'done'), to: snapshot([5], 'done') },
      ]),
    )

    expect(result.current.map((row) => getTaskKey(row))).toEqual(['a.md:[5]', 'b.md:[4]'])
    expect(result.current[0]?.checked).toBe(true)
  })

  it('drops a struck row whose task the write removed', async () => {
    const { result } = await renderHook(() => useRecentlyCompleted('/g', undefined))
    act(() => markRecentlyCompleted('/g', [task({ notePath: 'a.md', astPath: [1] })]))

    act(() => relocateRecentlyCompleted('/g', 'a.md', [{ from: snapshot([1], 'do it'), to: null }]))

    expect(result.current).toEqual([])
  })

  it('refreshes an edited struck row from its persisted Markdown', async () => {
    const { result } = await renderHook(() => useRecentlyCompleted('/g', undefined))
    act(() =>
      markRecentlyCompleted('/g', [task({ notePath: 'a.md', astPath: [2], markdown: 'old' })]),
    )

    act(() =>
      relocateRecentlyCompleted('/g', 'a.md', [
        { from: snapshot([2], 'old'), to: snapshot([2], 'edited [[2026-07-01]]') },
      ]),
    )

    expect(result.current[0]).toMatchObject({
      markdown: 'edited [[2026-07-01]]',
      text: 'edited 2026-07-01',
      dueDate: '2026-07-01',
    })
  })

  it('leaves a struck row alone when the write did not know its task', async () => {
    const { result } = await renderHook(() => useRecentlyCompleted('/g', undefined))
    act(() =>
      markRecentlyCompleted('/g', [task({ notePath: 'a.md', astPath: [1], markdown: 'dup' })]),
    )

    act(() =>
      relocateRecentlyCompleted('/g', 'a.md', [
        { from: snapshot([2], 'other'), to: snapshot([3], 'other') },
      ]),
    )

    expect(result.current.map((row) => getTaskKey(row))).toEqual(['a.md:[1]'])
  })

  it('drops a struck copy when the index reports the task open again with a newer updatedAt', async () => {
    const { result } = await renderHook(() => useRecentlyCompleted('/g', undefined))
    act(() =>
      markRecentlyCompleted('/g', [task({ notePath: 'a.md', astPath: [2], updatedAt: 100 })]),
    )
    expect(result.current).toHaveLength(1)

    // The source note was rewritten (checkbox flipped back to [ ]) and reindexed:
    // the live open row supersedes the session's struck shadow.
    act(() =>
      reconcileRecentlyCompleted('/g', [task({ notePath: 'a.md', astPath: [2], updatedAt: 200 })]),
    )
    expect(result.current).toEqual([])
  })

  it('keeps the struck copy when the open row is the pre-completion index state', async () => {
    const { result } = await renderHook(() => useRecentlyCompleted('/g', undefined))
    act(() =>
      markRecentlyCompleted('/g', [task({ notePath: 'a.md', astPath: [2], updatedAt: 100 })]),
    )

    // A refetch racing the completion's reindex restores the row unchanged
    // (same updatedAt) — the shadow must hold or the row flickers back open.
    act(() =>
      reconcileRecentlyCompleted('/g', [task({ notePath: 'a.md', astPath: [2], updatedAt: 100 })]),
    )
    expect(result.current).toHaveLength(1)
  })

  it('reconciles only the active graph root, and leaves unrelated struck tasks alone', async () => {
    const { result } = await renderHook(() => useRecentlyCompleted('/g', undefined))
    act(() =>
      markRecentlyCompleted('/g', [
        task({ notePath: 'a.md', astPath: [2], updatedAt: 100 }),
        task({ notePath: 'b.md', astPath: [2], updatedAt: 100 }),
      ]),
    )

    act(() =>
      reconcileRecentlyCompleted('/other', [
        task({ notePath: 'a.md', astPath: [2], updatedAt: 200 }),
      ]),
    )
    expect(result.current).toHaveLength(2)

    act(() =>
      reconcileRecentlyCompleted('/g', [task({ notePath: 'a.md', astPath: [2], updatedAt: 200 })]),
    )
    expect(result.current.map((row) => row.notePath)).toEqual(['b.md'])
  })

  it('useRecentlyCompleted reconciles against the open rows it is given', async () => {
    const { result, rerender } = await renderHook(
      (
        { open }: { open: readonly OpenTask[] | undefined } = {
          open: undefined,
        },
      ) => useRecentlyCompleted('/g', open),
      { initialProps: { open: undefined as readonly OpenTask[] | undefined } },
    )
    act(() =>
      markRecentlyCompleted('/g', [task({ notePath: 'a.md', astPath: [2], updatedAt: 100 })]),
    )
    expect(result.current).toHaveLength(1)

    // A fresh open read carrying the reopened row (newer updatedAt) sheds the
    // shadow from the view AND prunes the store, so the Archive count and
    // hasRecentlyCompleted agree with what renders.
    await rerender({
      open: [task({ notePath: 'a.md', astPath: [2], updatedAt: 200 })],
    })
    expect(result.current).toEqual([])
    expect(hasRecentlyCompleted('/g', 'a.md:[2]')).toBe(false)
  })

  it('excludes a reopened task during the render that sees it, before the store prune', async () => {
    // Render-phase capture: each entry is what a render (not an effect) returned,
    // so a superseded shadow surviving into the first fresh-data render would
    // record a 1 here even though a later effect prunes it.
    const lengths: number[] = []
    const { rerender } = await renderHook(
      (
        { open }: { open: readonly OpenTask[] | undefined } = {
          open: undefined,
        },
      ) => {
        const rows = useRecentlyCompleted('/g', open)
        lengths.push(rows.length)
        return rows
      },
      { initialProps: { open: undefined as readonly OpenTask[] | undefined } },
    )
    act(() =>
      markRecentlyCompleted('/g', [task({ notePath: 'a.md', astPath: [2], updatedAt: 100 })]),
    )
    const renders = lengths.length

    await rerender({
      open: [task({ notePath: 'a.md', astPath: [2], updatedAt: 200 })],
    })
    expect(lengths.slice(renders)).not.toContain(1)
    expect(lengths.at(-1)).toBe(0)
  })

  it('is scoped to a graph root — switching graphs yields an empty set', async () => {
    const { result, rerender } = await renderHook(
      ({ root }: { root: string } = { root: '/g' }) => useRecentlyCompleted(root, undefined),
      {
        initialProps: { root: '/g' },
      },
    )
    act(() => markRecentlyCompleted('/g', [task({ notePath: 'a.md', astPath: [2] })]))
    expect(result.current).toHaveLength(1)

    await rerender({ root: '/other' })
    expect(result.current).toEqual([])

    // Completing in the other graph discards the first graph's set entirely.
    act(() => markRecentlyCompleted('/other', [task({ notePath: 'z.md', astPath: [2] })]))
    expect(result.current).toHaveLength(1)
    await rerender({ root: '/g' })
    expect(result.current).toEqual([])
  })
})
