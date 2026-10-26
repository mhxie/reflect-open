import type { ReactElement } from 'react'
import { beforeEach, describe, expect, it, onTestFinished, vi, type MockInstance } from 'vitest'
import type { NoteDocumentService, NoteLinkResolverService } from '@reflect/core'
import { createTestCoreServices, type TestCoreServices } from '@reflect/core/testing'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import {
  MAX_NOTE_EMBED_DEPTH,
  useNoteEmbedSource,
  type NoteEmbedSource,
  type NoteEmbedSourceOptions,
} from './use-note-embed-source.ts'

let app: TestCoreServices
let resolve: MockInstance<NoteLinkResolverService['resolveWikiTarget']>
let read: MockInstance<NoteDocumentService['readExisting']>

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

function render(ui: ReactElement) {
  return renderInApp(ui, { core: app })
}

type View = Awaited<ReturnType<typeof render>>
function source(view: View): NoteEmbedSource {
  return JSON.parse(view.getByTestId('source').element().textContent ?? '{}') as NoteEmbedSource
}
async function expectSource(view: View, expected: NoteEmbedSource): Promise<void> {
  await vi.waitFor(() => expect(source(view)).toEqual(expected))
}

/**
 * Report this device's write of `path`, as a save does.
 */
function ownWrite(path: string): void {
  app.fileChanges.reportOwnWrite([{ path, kind: 'upsert' }])
}

/**
 * Deliver a watcher change of `path`.
 */
function externalChange(path: string): void {
  app.fileChanges.emit({ changes: [{ path, kind: 'upsert' }], source: 'external' })
}

/**
 * How many file-change and own-write listeners are attached.
 */
function listeners(): { changes: number; ownWrites: number } {
  const { changes, ownWrites } = app.fileChanges.listenerCount()
  return { changes, ownWrites }
}

beforeEach(() => {
  const database = createWasmTestDatabaseService()
  onTestFinished(() => database.close())
  app = createTestCoreServices({ database })
  resolve = vi
    .spyOn(app.noteLinkResolver, 'resolveWikiTarget')
    .mockResolvedValue({ kind: 'resolved', path: 'notes/Original.md' })
  read = vi.spyOn(app.noteDocuments, 'readExisting').mockResolvedValue('# Original\n\nBody')
})

describe('useNoteEmbedSource', () => {
  it('performs no resolution, read, or subscription while disabled', async () => {
    const view = await render(<Host options={{ ...OPTIONS, enabled: false }} />)
    const disabled = listeners()
    expect(resolve).not.toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()

    // Enabling subscribes once to each stream, so the disabled reader held none.
    await view.rerender(<Host options={OPTIONS} />)
    await vi.waitFor(() => {
      expect(listeners()).toEqual({
        changes: disabled.changes + 1,
        ownWrites: disabled.ownWrites + 1,
      })
    })
  })

  it('resolves in the source note and reads only the pinned graph generation', async () => {
    const view = await render(<Host options={OPTIONS} />)
    await expectSource(view, {
      kind: 'ready',
      path: 'notes/Original.md',
      source: '# Original\n\nBody',
    })
    expect(resolve).toHaveBeenCalledWith('Original#Details', 7, 'notes/Summary.md')
    expect(read).toHaveBeenCalledWith('notes/Original.md', 7)
  })

  it.each(['missing', 'ambiguous', 'unavailable'] as const)(
    'reports %s without reading or creating a note, and supports retry',
    async (kind) => {
      resolve.mockResolvedValue(
        kind === 'missing' ? { kind } : { kind, paths: ['notes/Original.md'] },
      )
      const view = await render(<Host options={OPTIONS} />)
      await expectSource(view, { kind })
      expect(read).not.toHaveBeenCalled()
      resolve.mockResolvedValue({ kind: 'resolved', path: 'notes/Original.md' })
      await view.getByRole('button', { name: 'Reload' }).click()
      await expectSource(view, {
        kind: 'ready',
        path: 'notes/Original.md',
        source: '# Original\n\nBody',
      })
    },
  )

  it('stops a cycle before reading the ancestor body', async () => {
    resolve.mockResolvedValue({ kind: 'resolved', path: OPTIONS.sourcePath })
    const view = await render(<Host options={OPTIONS} />)
    await expectSource(view, { kind: 'cycle' })
    expect(read).not.toHaveBeenCalled()
  })

  it('bounds nesting and refuses a missing graph before resolving anything', async () => {
    const ancestors = Array.from(
      { length: MAX_NOTE_EMBED_DEPTH + 1 },
      (_, index) => `notes/${index}.md`,
    )
    const view = await render(<Host options={{ ...OPTIONS, ancestors }} />)
    await expectSource(view, { kind: 'limit' })
    await view.rerender(<Host options={{ ...OPTIONS, generation: null }} />)
    await expectSource(view, { kind: 'unavailable' })
    expect(resolve).not.toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()
  })

  it('retires an old body read on a graph switch and hides the previous source immediately', async () => {
    const old = Promise.withResolvers<string>()
    read.mockReturnValueOnce(old.promise).mockResolvedValue('# New graph')
    const view = await render(<Host options={OPTIONS} />)
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))
    await view.rerender(<Host options={{ ...OPTIONS, graphKey: '/graph-b', generation: 8 }} />)
    await expectSource(view, { kind: 'ready', path: 'notes/Original.md', source: '# New graph' })
    old.resolve('# Old graph')
    await old.promise
    await expectSource(view, { kind: 'ready', path: 'notes/Original.md', source: '# New graph' })
    expect(read).toHaveBeenLastCalledWith('notes/Original.md', 8)
  })

  it('retires target resolution when disabled and re-reads when enabled again', async () => {
    const old = Promise.withResolvers<{ kind: 'resolved'; path: string }>()
    resolve.mockReturnValueOnce(old.promise)
    const view = await render(<Host options={OPTIONS} />)
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledTimes(1))
    await view.rerender(<Host options={{ ...OPTIONS, enabled: false }} />)
    old.resolve({ kind: 'resolved', path: 'notes/Retired.md' })
    await old.promise
    expect(read).not.toHaveBeenCalled()
    await view.rerender(<Host options={OPTIONS} />)
    await expectSource(view, {
      kind: 'ready',
      path: 'notes/Original.md',
      source: '# Original\n\nBody',
    })
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('refreshes its source on own writes and external changes, and unsubscribes when disabled', async () => {
    const view = await render(<Host options={{ ...OPTIONS, enabled: false }} />)
    const disabled = listeners()
    await view.rerender(<Host options={OPTIONS} />)
    await expectSource(view, {
      kind: 'ready',
      path: 'notes/Original.md',
      source: '# Original\n\nBody',
    })
    ownWrite('notes/Unrelated.md')
    externalChange('notes/Unrelated.md')
    expect(read).toHaveBeenCalledTimes(1)
    read.mockResolvedValue('# Own write')
    ownWrite('notes/Original.md')
    await expectSource(view, { kind: 'ready', path: 'notes/Original.md', source: '# Own write' })
    read.mockResolvedValue('# External write')
    externalChange('notes/Original.md')
    await expectSource(view, {
      kind: 'ready',
      path: 'notes/Original.md',
      source: '# External write',
    })
    await view.rerender(<Host options={{ ...OPTIONS, enabled: false }} />)
    await vi.waitFor(() => expect(listeners()).toEqual(disabled))
  })

  it('keeps the last source while a refresh is in flight', async () => {
    const view = await render(<Host options={OPTIONS} />)
    await expectSource(view, {
      kind: 'ready',
      path: 'notes/Original.md',
      source: '# Original\n\nBody',
    })
    const pending = Promise.withResolvers<string>()
    read.mockReturnValueOnce(pending.promise)
    ownWrite('notes/Original.md')
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2))
    await expectSource(view, {
      kind: 'ready',
      path: 'notes/Original.md',
      source: '# Original\n\nBody',
    })
    pending.resolve('# Refreshed')
    await expectSource(view, { kind: 'ready', path: 'notes/Original.md', source: '# Refreshed' })
  })

  it('turns a failed read into an unavailable state', async () => {
    read.mockRejectedValue(new Error('stale graph'))
    const view = await render(<Host options={OPTIONS} />)
    await expectSource(view, { kind: 'unavailable' })
  })

  it('keeps watching its resolved path while refreshing, so a newer own write retires a pending read', async () => {
    const view = await render(<Host options={OPTIONS} />)
    await expectSource(view, {
      kind: 'ready',
      path: 'notes/Original.md',
      source: '# Original\n\nBody',
    })
    const watching = listeners()
    const old = Promise.withResolvers<string>()
    read.mockReturnValueOnce(old.promise).mockResolvedValue('# Latest write')
    ownWrite('notes/Original.md')
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2))
    expect(listeners()).toEqual(watching)
    externalChange('notes/Unrelated.md')
    expect(read).toHaveBeenCalledTimes(2)
    ownWrite('notes/Original.md')
    await expectSource(view, { kind: 'ready', path: 'notes/Original.md', source: '# Latest write' })
    old.resolve('# Superseded write')
    await old.promise
    await expectSource(view, { kind: 'ready', path: 'notes/Original.md', source: '# Latest write' })
  })
})
