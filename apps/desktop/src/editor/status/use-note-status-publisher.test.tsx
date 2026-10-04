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
    expect(reader.result.current).toEqual({ characters: 'bold and Foo'.length })

    vi.useFakeTimers()
    publisher.result.current('今天写了七个字\n')
    expect(reader.result.current).toEqual({ characters: 12 })
    await publisher.act(async () => {
      vi.advanceTimersByTime(300)
    })
    await reader.rerender()
    expect(reader.result.current).toEqual({ characters: 7 })

    await publisher.unmount()
    await reader.rerender()
    expect(reader.result.current).toBeNull()
  })

  it('publishes nothing until the note has loaded', async () => {
    await renderHook(() => useNoteStatusPublisher('notes/b.md', null))
    const reader = await renderHook(() => useNoteStatus('notes/b.md'))

    expect(reader.result.current).toBeNull()
  })
})
