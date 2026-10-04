import { createRef } from 'react'
import { renderHook } from 'vitest-browser-react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useNoteStatus } from './note-status-store.ts'
import { useNoteStatusPublisher } from './use-note-status-publisher.ts'

afterEach(() => {
  vi.useRealTimers()
})

describe('useNoteStatusPublisher', () => {
  it('counts the loaded note, recounts after typing settles, and clears on unmount', async () => {
    const publisher = await renderHook(() =>
      useNoteStatusPublisher('notes/a.md', '**bold** and [[Foo]]\n'),
    )
    const reader = await renderHook(() => useNoteStatus('notes/a.md'))
    expect(reader.result.current).toEqual({
      characters: 'bold and Foo'.length,
      selectedCharacters: 0,
      editedAt: null,
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
    await renderHook(() => useNoteStatusPublisher('notes/b.md', null))
    const reader = await renderHook(() => useNoteStatus('notes/b.md'))

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
      useNoteStatusPublisher('notes/c.md', 'hello world\n', { pane: paneRef, getSelectedText }),
    )
    const reader = await renderHook(() => useNoteStatus('notes/c.md'))

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
})
