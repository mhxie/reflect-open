import { render } from 'vitest-browser-react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IndexAppliedListener } from '@reflect/core'
import { EmbeddingsSync } from './embeddings-sync.tsx'

const core = vi.hoisted(() => ({
  embedNote: vi.fn(async () => ({ written: 0 })),
  embedPrepareIndex: vi.fn(async () => false),
  embedRemove: vi.fn(async () => {}),
  subscribeIndexApplied: vi.fn(),
  activities: [] as string[],
  withActivity: vi.fn(async <T,>(reason: string, work: () => Promise<T>): Promise<T> => {
    core.activities.push(`begin ${reason}`)
    try {
      return await work()
    } finally {
      core.activities.push('end')
    }
  }),
}))
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  embedNote: core.embedNote,
  embedPrepareIndex: core.embedPrepareIndex,
  embedRemove: core.embedRemove,
  subscribeIndexApplied: core.subscribeIndexApplied,
  withActivity: core.withActivity,
}))

interface BackfillOptions {
  onProgress?: (done: number, total: number) => void
}

const semantic = vi.hoisted(() => ({
  backfillEmbeddingsVisibly: vi.fn<(options: BackfillOptions) => Promise<'completed'>>(
    async () => 'completed',
  ),
  consumeLegacySemanticOptIn: vi.fn(() => false),
  ensureEmbeddingsVisibly: vi.fn(async () => ({
    status: 'ready',
    model: 'all-MiniLM-L6-v2',
    dims: 384,
  })),
}))
vi.mock('@/lib/semantic.ts', () => semantic)

const progress = vi.hoisted(() => ({ setSemanticIndexProgress: vi.fn() }))
vi.mock('@/lib/semantic-index-progress.ts', () => progress)

const index = vi.hoisted(() => ({ indexing: false }))
vi.mock('@/providers/graph-provider.tsx', () => ({
  useGraph: () => ({
    graph: { root: '/g', name: 'g', generation: 1 },
    indexGeneration: 7,
    indexing: index.indexing,
  }),
}))
const semanticSetting = vi.hoisted(() => ({ enabled: true, model: 'all-MiniLM-L6-v2' }))
vi.mock('@/providers/settings-provider.tsx', () => ({
  useSettings: () => ({
    settings: {
      semanticSearchEnabled: semanticSetting.enabled,
      semanticModel: semanticSetting.model,
    },
    updateSettings: () => {},
  }),
}))
const runtime = vi.hoisted(() => ({
  status: { status: 'ready', model: 'all-MiniLM-L6-v2', dims: 384 } as Record<string, unknown>,
}))
vi.mock('@/lib/use-embed-status.ts', () => ({
  useEmbedStatus: () => runtime.status,
}))

let onApplied: IndexAppliedListener | null = null
const unlisten = vi.fn()

beforeEach(() => {
  semanticSetting.enabled = true
  semanticSetting.model = 'all-MiniLM-L6-v2'
  index.indexing = false
  runtime.status = { status: 'ready', model: 'all-MiniLM-L6-v2', dims: 384 }
  core.embedPrepareIndex.mockClear()
  semantic.ensureEmbeddingsVisibly.mockClear()
  onApplied = null
  unlisten.mockClear()
  core.embedNote.mockClear()
  core.embedRemove.mockClear()
  semantic.backfillEmbeddingsVisibly.mockClear()
  progress.setSemanticIndexProgress.mockClear()
  core.activities.length = 0
  core.subscribeIndexApplied.mockReset().mockImplementation((handler: IndexAppliedListener) => {
    onApplied = handler
    return unlisten
  })
})

/** One macrotask — long enough for a would-be queue item to have started. */
function flushQueue(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('EmbeddingsSync', () => {
  it('backfills and follows applied index batches while enabled and ready', async () => {
    await render(<EmbeddingsSync />)
    await vi.waitFor(() => expect(semantic.backfillEmbeddingsVisibly).toHaveBeenCalled())
    await vi.waitFor(() => expect(onApplied).not.toBeNull())

    onApplied?.([{ kind: 'upsert', path: 'notes/a.md' }], 7)
    await vi.waitFor(() =>
      expect(core.embedNote).toHaveBeenCalledWith({
        path: 'notes/a.md',
        generation: 7,
        modelId: 'all-MiniLM-L6-v2',
      }),
    )
  })

  it('ignores a delayed emit from a superseded index session', async () => {
    await render(<EmbeddingsSync />)
    await vi.waitFor(() => expect(onApplied).not.toBeNull())

    onApplied?.([{ kind: 'upsert', path: 'notes/a.md' }], 6)
    await flushQueue()
    expect(core.embedNote).not.toHaveBeenCalled()
  })

  it('never embeds asset-file changes riding the same batches', async () => {
    await render(<EmbeddingsSync />)
    await vi.waitFor(() => expect(onApplied).not.toBeNull())

    onApplied?.(
      [
        { kind: 'upsert', path: 'assets/photo.png' },
        { kind: 'remove', path: 'assets/old.pdf' },
      ],
      7,
    )
    await flushQueue()
    expect(core.embedNote).not.toHaveBeenCalled()
    expect(core.embedRemove).not.toHaveBeenCalled()
  })

  it('starts no embedding work while semantic search is disabled', async () => {
    semanticSetting.enabled = false
    await render(<EmbeddingsSync />)
    await flushQueue()
    expect(semantic.backfillEmbeddingsVisibly).not.toHaveBeenCalled()
    expect(core.subscribeIndexApplied).not.toHaveBeenCalled()
  })

  it('pauses follow-up work the moment semantic search is disabled', async () => {
    const view = await render(<EmbeddingsSync />)
    await vi.waitFor(() => expect(onApplied).not.toBeNull())

    semanticSetting.enabled = false
    await view.rerender(<EmbeddingsSync />)
    await vi.waitFor(() => expect(unlisten).toHaveBeenCalled())

    // A batch still in flight when the teardown ran must be dropped, not
    // embedded behind the user's back.
    onApplied?.([{ kind: 'upsert', path: 'notes/b.md' }], 7)
    await flushQueue()
    expect(core.embedNote).not.toHaveBeenCalled()
  })

  it('refits the vector table to the loaded model before backfilling', async () => {
    await render(<EmbeddingsSync />)
    await vi.waitFor(() => expect(semantic.backfillEmbeddingsVisibly).toHaveBeenCalled())
    expect(core.embedPrepareIndex).toHaveBeenCalledWith('all-MiniLM-L6-v2', 384, 7)
    expect(core.embedPrepareIndex.mock.invocationCallOrder[0]!).toBeLessThan(
      semantic.backfillEmbeddingsVisibly.mock.invocationCallOrder[0]!,
    )
  })

  it('waits for the index pass to settle before backfilling', async () => {
    index.indexing = true
    const view = await render(<EmbeddingsSync />)
    await flushQueue()
    expect(semantic.backfillEmbeddingsVisibly).not.toHaveBeenCalled()

    index.indexing = false
    await view.rerender(<EmbeddingsSync />)
    await vi.waitFor(() => expect(semantic.backfillEmbeddingsVisibly).toHaveBeenCalled())
  })

  it('holds an App Nap activity for exactly the backfill', async () => {
    semantic.backfillEmbeddingsVisibly.mockImplementationOnce(async () => {
      core.activities.push('backfill')
      return 'completed'
    })
    await render(<EmbeddingsSync />)
    await vi.waitFor(() => expect(core.activities).toContain('end'))
    expect(core.activities).toEqual([
      'begin Embedding notes for semantic search',
      'backfill',
      'end',
    ])
  })

  it('publishes the backfill position every few notes and clears it after', async () => {
    semantic.backfillEmbeddingsVisibly.mockImplementationOnce(async ({ onProgress }) => {
      for (let done = 1; done <= 25; done += 1) {
        onProgress?.(done, 25)
      }
      return 'completed'
    })
    await render(<EmbeddingsSync />)
    await vi.waitFor(() => expect(progress.setSemanticIndexProgress).toHaveBeenLastCalledWith(null))
    expect(progress.setSemanticIndexProgress.mock.calls).toEqual([
      [{ done: 10, total: 25 }],
      [{ done: 20, total: 25 }],
      [{ done: 25, total: 25 }],
      [null],
    ])
  })

  it('switches to the configured model instead of embedding with another', async () => {
    semanticSetting.model = 'embeddinggemma-300m'
    await render(<EmbeddingsSync />)
    await vi.waitFor(() =>
      expect(semantic.ensureEmbeddingsVisibly).toHaveBeenCalledWith('embeddinggemma-300m'),
    )
    await flushQueue()
    expect(core.embedPrepareIndex).not.toHaveBeenCalled()
    expect(semantic.backfillEmbeddingsVisibly).not.toHaveBeenCalled()
  })
})
