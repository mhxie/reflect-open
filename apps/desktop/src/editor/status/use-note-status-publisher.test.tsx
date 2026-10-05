import { createRef } from 'react'
import { cleanup, renderHook } from 'vitest-browser-react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NoteState } from '@reflect/core'
import type { NoteProtection } from './note-protection.ts'
import { useNoteStatus, type NoteStatusScope } from './note-status-store.ts'
import { useNoteStatusPublisher } from './use-note-status-publisher.ts'

const EDITABLE: NoteState = {
  kind: 'editable',
  isPrivate: false,
  isLocalOnly: false,
  isReadOnly: false,
  isProtected: false,
}

function scope(path: string, generation = 17): NoteStatusScope {
  return { generation, path }
}

afterEach(async () => {
  await cleanup()
  vi.useRealTimers()
})

describe('useNoteStatusPublisher', () => {
  it('expires recovery callbacks across graph changes and unmounts', async () => {
    let generation = 61
    const retrySave = vi.fn()
    const protection: NoteProtection = { kind: 'save-blocked', message: 'Write blocked', retrySave }
    const protectedState: NoteState = {
      ...EDITABLE,
      kind: 'protected',
      isProtected: true,
      isReadOnly: true,
    }
    const publisher = await renderHook(() =>
      useNoteStatusPublisher(scope('notes/retry.md', generation), 'unsaved\n', protectedState, {
        protection,
      }),
    )
    const first = await renderHook(() => useNoteStatus(scope('notes/retry.md', 61)))
    const second = await renderHook(() => useNoteStatus(scope('notes/retry.md', 62)))
    const oldProtection = first.result.current?.protection
    if (oldProtection?.kind !== 'save-blocked') {
      throw new Error('Expected blocked-save recovery')
    }

    generation = 62
    await publisher.rerender()
    await second.rerender()
    oldProtection.retrySave()
    expect(retrySave).not.toHaveBeenCalled()

    const currentProtection = second.result.current?.protection
    if (currentProtection?.kind !== 'save-blocked') {
      throw new Error('Expected current blocked-save recovery')
    }
    currentProtection.retrySave()
    expect(retrySave).toHaveBeenCalledOnce()

    await publisher.unmount()
    currentProtection.retrySave()
    expect(retrySave).toHaveBeenCalledOnce()
  })

  it('does not retry through a replaced pane or revive its callback on unmount', async () => {
    const firstRetry = vi.fn()
    const secondRetry = vi.fn()
    const protectedState: NoteState = {
      ...EDITABLE,
      kind: 'protected',
      isProtected: true,
      isReadOnly: true,
    }
    const first = await renderHook(() =>
      useNoteStatusPublisher(scope('notes/retry.md'), 'first\n', protectedState, {
        protection: { kind: 'save-blocked', message: 'First blocked', retrySave: firstRetry },
      }),
    )
    const reader = await renderHook(() => useNoteStatus(scope('notes/retry.md')))
    const oldProtection = reader.result.current?.protection
    if (oldProtection?.kind !== 'save-blocked') {
      throw new Error('Expected first blocked-save recovery')
    }
    await renderHook(() =>
      useNoteStatusPublisher(scope('notes/retry.md'), 'second\n', protectedState, {
        protection: { kind: 'save-blocked', message: 'Second blocked', retrySave: secondRetry },
      }),
    )
    await reader.rerender()
    await first.unmount()
    oldProtection.retrySave()
    expect(firstRetry).not.toHaveBeenCalled()

    const currentProtection = reader.result.current?.protection
    if (currentProtection?.kind !== 'save-blocked') {
      throw new Error('Expected successor blocked-save recovery')
    }
    currentProtection.retrySave()
    expect(secondRetry).toHaveBeenCalledOnce()
  })

  it('expires both conflict choices after pane replacement, graph changes, and unmount', async () => {
    let generation = 63
    const firstKeep = vi.fn()
    const firstLoad = vi.fn()
    const secondKeep = vi.fn()
    const secondLoad = vi.fn()
    const protectedState: NoteState = {
      ...EDITABLE,
      kind: 'protected',
      isProtected: true,
      isReadOnly: true,
    }
    const first = await renderHook(() =>
      useNoteStatusPublisher(scope('notes/conflict.md', 63), 'first\n', protectedState, {
        protection: {
          kind: 'external-change',
          message: 'First blocked',
          keepMine: firstKeep,
          loadTheirs: firstLoad,
        },
      }),
    )
    const reader = await renderHook(() => useNoteStatus(scope('notes/conflict.md', generation)))
    const oldProtection = reader.result.current?.protection
    if (oldProtection?.kind !== 'external-change') {
      throw new Error('Expected first conflict recovery')
    }
    const protection: NoteProtection = {
      kind: 'external-change',
      message: 'Second blocked',
      keepMine: secondKeep,
      loadTheirs: secondLoad,
    }
    const second = await renderHook(() =>
      useNoteStatusPublisher(scope('notes/conflict.md', generation), 'second\n', protectedState, {
        protection,
      }),
    )
    await reader.rerender()
    await first.unmount()
    oldProtection.keepMine()
    oldProtection.loadTheirs()
    expect(firstKeep).not.toHaveBeenCalled()
    expect(firstLoad).not.toHaveBeenCalled()

    const successor = reader.result.current?.protection
    if (successor?.kind !== 'external-change') {
      throw new Error('Expected successor conflict recovery')
    }
    successor.keepMine()
    successor.loadTheirs()
    expect(secondKeep).toHaveBeenCalledOnce()
    expect(secondLoad).toHaveBeenCalledOnce()

    generation = 64
    await second.rerender()
    await reader.rerender()
    successor.keepMine()
    successor.loadTheirs()
    expect(secondKeep).toHaveBeenCalledOnce()
    expect(secondLoad).toHaveBeenCalledOnce()

    const current = reader.result.current?.protection
    if (current?.kind !== 'external-change') {
      throw new Error('Expected current conflict recovery')
    }
    current.keepMine()
    current.loadTheirs()
    expect(secondKeep).toHaveBeenCalledTimes(2)
    expect(secondLoad).toHaveBeenCalledTimes(2)
    await second.unmount()
    current.keepMine()
    current.loadTheirs()
    expect(secondKeep).toHaveBeenCalledTimes(2)
    expect(secondLoad).toHaveBeenCalledTimes(2)
  })

  it('counts the loaded note, recounts after typing settles, and clears on unmount', async () => {
    const publisher = await renderHook(() =>
      useNoteStatusPublisher(scope('notes/a.md'), '**bold** and [[Foo]]\n', EDITABLE),
    )
    const reader = await renderHook(() => useNoteStatus(scope('notes/a.md')))
    expect(reader.result.current).toEqual({
      characters: 'bold and Foo'.length,
      selectedCharacters: 0,
      editedAt: null,
      state: EDITABLE,
      protection: null,
    })

    vi.useFakeTimers()
    publisher.result.current('今天写了七个字\n')
    expect(reader.result.current?.characters).toBe(12)
    await publisher.act(async () => {
      vi.advanceTimersByTime(300)
    })
    await reader.rerender()
    expect(reader.result.current?.characters).toBe(7)
    expect(reader.result.current?.editedAt).toBeGreaterThan(0)

    await publisher.unmount()
    await reader.rerender()
    expect(reader.result.current).toBeNull()
  })

  it('publishes nothing until the note has loaded', async () => {
    await renderHook(() => useNoteStatusPublisher(scope('notes/b.md'), null, EDITABLE))
    const reader = await renderHook(() => useNoteStatus(scope('notes/b.md')))

    expect(reader.result.current).toBeNull()
  })

  it('publishes nothing without an open graph file generation', async () => {
    await renderHook(() => useNoteStatusPublisher(null, 'loaded text\n', EDITABLE))
    const reader = await renderHook(() => useNoteStatus(scope('notes/b.md')))

    expect(reader.result.current).toBeNull()
  })

  it('counts a selection inside its editor, and nothing once it moves out', async () => {
    const pane = document.createElement('div')
    pane.innerHTML = '<div contenteditable="true"><p>hello world</p></div><p>outside</p>'
    document.body.append(pane)
    const paneRef = createRef<HTMLElement>() as { current: HTMLElement | null }
    paneRef.current = pane
    const getSelectedText = vi.fn(() => 'hello')
    await renderHook(() =>
      useNoteStatusPublisher(scope('notes/c.md'), 'hello world\n', EDITABLE, {
        selection: { pane: paneRef, getSelectedText },
      }),
    )
    const reader = await renderHook(() => useNoteStatus(scope('notes/c.md')))

    const select = (node: Node, end: number) => {
      const range = document.createRange()
      range.setStart(node, 0)
      range.setEnd(node, end)
      window.getSelection()!.removeAllRanges()
      window.getSelection()!.addRange(range)
    }
    select(pane.querySelector('[contenteditable] p')!.firstChild!, 5)
    await vi.waitFor(async () => {
      await reader.rerender()
      expect(reader.result.current?.selectedCharacters).toBe(5)
    })

    select(pane.querySelector(':scope > p')!.firstChild!, 3)
    await vi.waitFor(async () => {
      await reader.rerender()
      expect(reader.result.current?.selectedCharacters).toBe(0)
    })
    pane.remove()
  })

  it('updates live privacy and protection without resetting counts or edit time', async () => {
    let state = EDITABLE
    const publisher = await renderHook(() =>
      useNoteStatusPublisher(scope('notes/state.md'), 'original\n', state),
    )
    const reader = await renderHook(() => useNoteStatus(scope('notes/state.md')))
    vi.useFakeTimers()
    publisher.result.current('a longer live buffer\n')
    await publisher.act(async () => {
      vi.advanceTimersByTime(300)
    })
    await reader.rerender()
    const edited = reader.result.current
    expect(edited?.characters).toBe('a longer live buffer'.length)
    expect(edited?.editedAt).toBeGreaterThan(0)

    state = { ...EDITABLE, kind: 'private', isPrivate: true }
    await publisher.rerender()
    await reader.rerender()
    expect(reader.result.current).toEqual({ ...edited, state })

    state = { ...EDITABLE, kind: 'protected', isReadOnly: true, isProtected: true }
    await publisher.rerender()
    await reader.rerender()
    expect(reader.result.current).toEqual({ ...edited, state })
  })

  it('keeps same-path statuses separate across file generations', async () => {
    await renderHook(() =>
      useNoteStatusPublisher(scope('notes/shared.md', 31), 'first graph\n', EDITABLE),
    )
    await renderHook(() =>
      useNoteStatusPublisher(scope('notes/shared.md', 32), 'second graph is different\n', EDITABLE),
    )
    const first = await renderHook(() => useNoteStatus(scope('notes/shared.md', 31)))
    const second = await renderHook(() => useNoteStatus(scope('notes/shared.md', 32)))

    expect(first.result.current?.characters).toBe('first graph'.length)
    expect(second.result.current?.characters).toBe('second graph is different'.length)
  })

  it('discards old timers and old change callbacks after a same-path graph switch', async () => {
    let generation = 41
    let markdown = 'first graph\n'
    const publisher = await renderHook(() =>
      useNoteStatusPublisher(scope('notes/shared.md', generation), markdown, EDITABLE),
    )
    const first = await renderHook(() => useNoteStatus(scope('notes/shared.md', 41)))
    const second = await renderHook(() => useNoteStatus(scope('notes/shared.md', 42)))
    const oldChange = publisher.result.current
    vi.useFakeTimers()
    oldChange('an old queued recount\n')

    generation = 42
    markdown = 'second graph\n'
    await publisher.rerender()
    oldChange('an old callback delivered after switching\n')
    await publisher.act(async () => {
      vi.advanceTimersByTime(300)
    })
    await first.rerender()
    await second.rerender()

    expect(first.result.current).toBeNull()
    expect(second.result.current).toEqual({
      characters: 'second graph'.length,
      selectedCharacters: 0,
      editedAt: null,
      state: EDITABLE,
      protection: null,
    })
  })

  it('does not clear a successor pane when an older owner unmounts', async () => {
    const first = await renderHook(() =>
      useNoteStatusPublisher(scope('notes/shared.md'), 'first pane\n', EDITABLE),
    )
    await renderHook(() =>
      useNoteStatusPublisher(scope('notes/shared.md'), 'successor pane\n', EDITABLE),
    )
    const reader = await renderHook(() => useNoteStatus(scope('notes/shared.md')))

    await first.unmount()
    await reader.rerender()

    expect(reader.result.current?.characters).toBe('successor pane'.length)
  })
})
