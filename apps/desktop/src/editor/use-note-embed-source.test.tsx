import type { ReactElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import type { FileChange } from '@reflect/core'
import { deferred } from '@/test-utils/deferred.ts'
import {
  MAX_NOTE_EMBED_DEPTH,
  useNoteEmbedSource,
  type NoteEmbedSource,
  type NoteEmbedSourceOptions,
} from './use-note-embed-source.ts'

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  read: vi.fn(),
  ownWrites: new Set<(path: string) => void>(),
  fileChanges: null as ((changes: FileChange[]) => void) | null,
}))
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  resolveExistingWikiTarget: mocks.resolve,
  subscribeOwnWrites: (handler: (path: string) => void) => {
    mocks.ownWrites.add(handler)
    return () => mocks.ownWrites.delete(handler)
  },
}))
vi.mock('@/lib/read-existing-note-source.ts', () => ({ readExistingNoteSource: mocks.read }))
vi.mock('@/lib/use-file-changes.ts', () => ({
  useFileChanges: (handler: ((changes: FileChange[]) => void) | null) => {
    mocks.fileChanges = handler
  },
}))

const OPTIONS: NoteEmbedSourceOptions = {
  target: 'Original#Details',
  sourcePath: 'notes/Summary.md',
  generation: 7,
  graphKey: '/graph-a',
  ancestors: ['notes/Summary.md'],
  enabled: true,
}

function Host({ options }: { options: NoteEmbedSourceOptions }): ReactElement {
  const { source, reload } = useNoteEmbedSource(options)
  return (
    <>
      <output data-testid="source">{JSON.stringify(source)}</output>
      <button type="button" onClick={reload}>
        Reload
      </button>
    </>
  )
}

type View = Awaited<ReturnType<typeof render>>
function source(view: View): NoteEmbedSource {
  return JSON.parse(view.getByTestId('source').element().textContent ?? '{}') as NoteEmbedSource
}
async function expectSource(view: View, expected: NoteEmbedSource): Promise<void> {
  await vi.waitFor(() => expect(source(view)).toEqual(expected))
}

beforeEach(() => {
  mocks.resolve.mockReset().mockResolvedValue({ kind: 'resolved', path: 'notes/Original.md' })
  mocks.read.mockReset().mockResolvedValue('# Original\n\nBody')
  mocks.ownWrites.clear()
  mocks.fileChanges = null
})

describe('useNoteEmbedSource', () => {
  it('performs no resolution, read, or subscription while disabled', async () => {
    const view = await render(<Host options={{ ...OPTIONS, enabled: false }} />)
    expect(mocks.resolve).not.toHaveBeenCalled()
    expect(mocks.read).not.toHaveBeenCalled()
    expect(mocks.ownWrites.size).toBe(0)
    expect(mocks.fileChanges).toBeNull()
    await view.unmount()
  })

  it('resolves in the source note and reads only the pinned graph generation', async () => {
    const view = await render(<Host options={OPTIONS} />)
    await expectSource(view, {
      kind: 'ready',
      path: 'notes/Original.md',
      source: '# Original\n\nBody',
    })
    expect(mocks.resolve).toHaveBeenCalledWith('Original#Details', 7, 'notes/Summary.md')
    expect(mocks.read).toHaveBeenCalledWith('notes/Original.md', 7)
    await view.unmount()
  })

  it.each(['missing', 'ambiguous', 'unavailable'] as const)(
    'reports %s without reading or creating a note, and supports retry',
    async (kind) => {
      mocks.resolve.mockResolvedValue({ kind })
      const view = await render(<Host options={OPTIONS} />)
      await expectSource(view, { kind })
      expect(mocks.read).not.toHaveBeenCalled()
      mocks.resolve.mockResolvedValue({ kind: 'resolved', path: 'notes/Original.md' })
      await view.getByRole('button', { name: 'Reload' }).click()
      await expectSource(view, {
        kind: 'ready',
        path: 'notes/Original.md',
        source: '# Original\n\nBody',
      })
      await view.unmount()
    },
  )

  it('stops a cycle before reading the ancestor body', async () => {
    mocks.resolve.mockResolvedValue({ kind: 'resolved', path: OPTIONS.sourcePath })
    const view = await render(<Host options={OPTIONS} />)
    await expectSource(view, { kind: 'cycle' })
    expect(mocks.read).not.toHaveBeenCalled()
    await view.unmount()
  })

  it('bounds nesting and refuses a missing graph before resolving anything', async () => {
    const ancestors = Array.from({ length: MAX_NOTE_EMBED_DEPTH + 1 }, (_, i) => `notes/${i}.md`)
    const view = await render(<Host options={{ ...OPTIONS, ancestors }} />)
    await expectSource(view, { kind: 'limit' })
    await view.rerender(<Host options={{ ...OPTIONS, generation: null }} />)
    await expectSource(view, { kind: 'unavailable' })
    expect(mocks.resolve).not.toHaveBeenCalled()
    expect(mocks.read).not.toHaveBeenCalled()
    await view.unmount()
  })

  it('retires an old body read on a graph switch and hides the previous source immediately', async () => {
    const old = deferred<string>()
    mocks.read.mockReturnValueOnce(old.promise).mockResolvedValue('# New graph')
    const view = await render(<Host options={OPTIONS} />)
    await vi.waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(1))
    await view.rerender(<Host options={{ ...OPTIONS, graphKey: '/graph-b', generation: 8 }} />)
    await expectSource(view, { kind: 'ready', path: 'notes/Original.md', source: '# New graph' })
    old.resolve('# Old graph')
    await old.promise
    await expectSource(view, { kind: 'ready', path: 'notes/Original.md', source: '# New graph' })
    expect(mocks.read).toHaveBeenLastCalledWith('notes/Original.md', 8)
    await view.unmount()
  })

  it('retires target resolution when disabled and re-reads when enabled again', async () => {
    const old = deferred<{ kind: 'resolved'; path: string }>()
    mocks.resolve.mockReturnValueOnce(old.promise)
    const view = await render(<Host options={OPTIONS} />)
    await vi.waitFor(() => expect(mocks.resolve).toHaveBeenCalledTimes(1))
    await view.rerender(<Host options={{ ...OPTIONS, enabled: false }} />)
    old.resolve({ kind: 'resolved', path: 'notes/Retired.md' })
    await old.promise
    expect(mocks.read).not.toHaveBeenCalled()
    await view.rerender(<Host options={OPTIONS} />)
    await expectSource(view, {
      kind: 'ready',
      path: 'notes/Original.md',
      source: '# Original\n\nBody',
    })
    expect(mocks.read).toHaveBeenCalledTimes(1)
    await view.unmount()
  })

  it('refreshes its source on own writes and external changes, and unsubscribes when disabled', async () => {
    const view = await render(<Host options={OPTIONS} />)
    await expectSource(view, {
      kind: 'ready',
      path: 'notes/Original.md',
      source: '# Original\n\nBody',
    })
    await vi.waitFor(() => expect(mocks.ownWrites.size).toBe(1))
    for (const handler of mocks.ownWrites) handler('notes/Unrelated.md')
    mocks.fileChanges?.([{ path: 'notes/Unrelated.md', kind: 'upsert' }])
    expect(mocks.read).toHaveBeenCalledTimes(1)
    mocks.read.mockResolvedValue('# Own write')
    for (const handler of mocks.ownWrites) handler('notes/Original.md')
    await expectSource(view, { kind: 'ready', path: 'notes/Original.md', source: '# Own write' })
    mocks.read.mockResolvedValue('# External write')
    mocks.fileChanges?.([{ path: 'notes/Original.md', kind: 'upsert' }])
    await expectSource(view, {
      kind: 'ready',
      path: 'notes/Original.md',
      source: '# External write',
    })
    await view.rerender(<Host options={{ ...OPTIONS, enabled: false }} />)
    expect(mocks.ownWrites.size).toBe(0)
    expect(mocks.fileChanges).toBeNull()
    await view.unmount()
  })

  it('turns a failed read into an unavailable state', async () => {
    mocks.read.mockRejectedValue(new Error('stale graph'))
    const view = await render(<Host options={OPTIONS} />)
    await expectSource(view, { kind: 'unavailable' })
    await view.unmount()
  })

  it('keeps watching its resolved path while refreshing, so a newer own write retires a pending read', async () => {
    const view = await render(<Host options={OPTIONS} />)
    await expectSource(view, {
      kind: 'ready',
      path: 'notes/Original.md',
      source: '# Original\n\nBody',
    })
    const old = deferred<string>()
    mocks.read.mockReturnValueOnce(old.promise).mockResolvedValue('# Latest write')
    for (const handler of mocks.ownWrites) handler('notes/Original.md')
    await vi.waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(2))
    expect(mocks.ownWrites.size).toBe(1)
    mocks.fileChanges?.([{ path: 'notes/Unrelated.md', kind: 'upsert' }])
    expect(mocks.read).toHaveBeenCalledTimes(2)
    for (const handler of mocks.ownWrites) handler('notes/Original.md')
    await expectSource(view, { kind: 'ready', path: 'notes/Original.md', source: '# Latest write' })
    old.resolve('# Superseded write')
    await old.promise
    await expectSource(view, { kind: 'ready', path: 'notes/Original.md', source: '# Latest write' })
    await view.unmount()
  })
})
