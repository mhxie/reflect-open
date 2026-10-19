import { describe, expect, it, vi } from 'vitest'
import { createGraphSession, type GraphRole } from '../graph/graph-session.ts'
import { isLocalOnlyPath, type LocalOnlyFolders } from '../graph/local-only.ts'
import {
  createTestDatabaseService,
  createTestEmbeddingIndexService,
  createTestEmbeddingRuntimeService,
  createTestGraphSessionService,
  createTestIndexLifecycleService,
  createTestIndexStoreService,
  createTestLoggerService,
  createTestNoteFileService,
  createTestProgressPort,
  createTestRetrievalService,
  createTestSemanticSearchService,
  createTestSettingsService,
  createTestStorageService,
  seedNotes,
  type TestNote,
} from '../testing/index.ts'
import type {
  EmbeddingBackfillOptions,
  EmbeddingBackfillResult,
} from './embedding-index-service.ts'
import type { EmbedStatus } from './embedding-runtime-service.ts'
import type { SemanticModelId } from './models.ts'
import type { RetrievalHit } from './retrieval-service.ts'
import type { SemanticIndexProgress, SemanticSearchService } from './semantic-search-service.ts'

const MODEL = 'all-MiniLM-L6-v2'
const GEMMA = 'embeddinggemma-300m'
const READY: EmbedStatus = { status: 'ready', model: MODEL, dims: 384 }
const GRAPH = { root: '/g', name: 'g', generation: 1 }
const BACKFILL_ACTIVITY = 'Embedding notes for semantic search'

/**
 * One edge of a native activity hold, with how far the refit and the
 * embedding had come at that moment.
 */
interface ActivityEvent {
  readonly event: 'begin' | 'end'
  readonly reason: string
  readonly refits: number
  readonly embedded: number
}

/**
 * `count` notes, `notes/01.md` onwards, each a heading and a line.
 */
function graphNotes(count: number): TestNote[] {
  return Array.from({ length: count }, (_, at) => ({
    path: `notes/${String(at + 1).padStart(2, '0')}.md`,
    markdown: `# Note ${at + 1}\n\nLine ${at + 1}.\n`,
  }))
}

/**
 * A semantic search over fakes, with the graph `/g` open at index generation
 * 7 and `notes` notes indexed (none by default).
 */
async function setup(options?: {
  enabled?: boolean
  model?: SemanticModelId
  status?: EmbedStatus
  legacyOptIn?: string
  role?: GraphRole
  failClear?: boolean
  indexing?: boolean
  notes?: number
  localOnlyFolders?: string[]
  graphGeneration?: number
  backfill?: (options: EmbeddingBackfillOptions) => Promise<EmbeddingBackfillResult>
  relatedNotes?: (path: string, limit?: number) => RetrievalHit[]
}) {
  const logger = createTestLoggerService()
  const progress = createTestProgressPort()
  const settings = createTestSettingsService({
    semanticSearchEnabled: options?.enabled ?? true,
    ...(options?.model === undefined ? {} : { semanticModel: options.model }),
  })
  await settings.whenLoaded()
  const storage = createTestStorageService(
    options?.legacyOptIn === undefined
      ? {}
      : { local: { 'reflect.semantic.enabled': options.legacyOptIn } },
  )
  const runtime = createTestEmbeddingRuntimeService({ status: options?.status ?? READY })
  const session = createGraphSession({ ...GRAPH, indexGeneration: 7 })
  const indexLifecycle = createTestIndexLifecycleService({
    logger,
    progress,
    graphSession: { getState: () => ({ session }), subscribe: () => () => {} },
    indexStore: createTestIndexStoreService({
      fail: (call) =>
        options?.failClear === true && call.method === 'clear'
          ? new Error('index on fire')
          : undefined,
    }),
  })
  const notes = graphNotes(options?.notes ?? 0)
  const database = createTestDatabaseService()
  seedNotes(database, notes)
  const embeddingIndex = createTestEmbeddingIndexService({
    embeddingRuntime: runtime,
    database,
    noteFile: createTestNoteFileService({
      files: Object.fromEntries(notes.map((note) => [note.path, note.markdown])),
    }),
    indexLifecycle,
    logger,
    ...(options?.backfill === undefined ? {} : { backfill: options.backfill }),
  })
  const retrieval = createTestRetrievalService(
    options?.relatedNotes === undefined ? {} : { relatedNotes: options.relatedNotes },
  )
  const graphSession = createTestGraphSessionService({
    indexLifecycle,
    logger,
    graph: {
      ...GRAPH,
      generation: options?.graphGeneration ?? GRAPH.generation,
      indexGeneration: 7,
      localOnlyFolders: options?.localOnlyFolders ?? [],
    },
    ...(options?.indexing === true ? { state: { indexing: true } } : {}),
  })
  const activity: ActivityEvent[] = []
  const record = (event: ActivityEvent['event'], reason: string): void => {
    activity.push({
      event,
      reason,
      refits: embeddingIndex.prepares().length,
      embedded: embeddingIndex.applied().length,
    })
  }
  const semanticSearch = createTestSemanticSearchService({
    embeddingRuntime: runtime,
    embeddingIndex,
    retrieval,
    settings,
    storage,
    nativeActivity: {
      run: async (reason, work) => {
        record('begin', reason)
        try {
          return await work()
        } finally {
          record('end', reason)
        }
      },
    },
    role: options?.role ?? 'main',
    indexLifecycle,
    graphSession,
    logger,
  })
  return {
    semanticSearch,
    settings,
    storage,
    runtime,
    indexLifecycle,
    embeddingIndex,
    retrieval,
    graphSession,
    progress,
    activity,
    logger,
  }
}

/**
 * One macrotask — long enough for a would-be reaction to have started.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * Every index progress value `semanticSearch` publishes from now on, in order.
 */
function publishedProgress(
  semanticSearch: SemanticSearchService,
): (SemanticIndexProgress | null)[] {
  const published: (SemanticIndexProgress | null)[] = []
  semanticSearch.subscribe(() => {
    published.push(semanticSearch.getIndexProgress())
  })
  return published
}

describe('start', () => {
  it('carries a stored legacy opt-in into the settings exactly once', async () => {
    const { semanticSearch, settings, storage } = await setup({
      enabled: false,
      legacyOptIn: 'true',
    })

    const stop = semanticSearch.start()
    expect(settings.get().semanticSearchEnabled).toBe(true)
    expect(storage.dump().local).toEqual({})
    stop()

    // The settings document owns the opt-in after: a later start changes nothing.
    settings.update({ semanticSearchEnabled: false })
    semanticSearch.start()()
    expect(settings.get().semanticSearchEnabled).toBe(false)
  })

  it('leaves the settings alone when the legacy key was never set', async () => {
    const { semanticSearch, settings } = await setup({ enabled: false })

    const stop = semanticSearch.start()
    await flush()

    expect(settings.get().semanticSearchEnabled).toBe(false)
    expect(settings.saves()).toEqual([])
    stop()
  })

  it('loads the model while enabled and untouched, then backfills and follows', async () => {
    const { semanticSearch, runtime, embeddingIndex } = await setup()

    const stop = semanticSearch.start()
    await vi.waitFor(() => expect(embeddingIndex.follows()).toHaveLength(1))

    expect(runtime.ensuredModels()).toEqual([MODEL])
    expect(embeddingIndex.follows()).toEqual([{ generation: 7, modelId: MODEL }])
    stop()
  })

  it('refits the vector table to the loaded model before backfilling', async () => {
    const { semanticSearch, embeddingIndex, activity } = await setup({ notes: 2 })

    const stop = semanticSearch.start()
    await vi.waitFor(() => expect(activity).toHaveLength(2))

    expect(embeddingIndex.prepares()).toEqual([{ model: MODEL, dims: 384, generation: 7 }])
    expect(activity[0]).toMatchObject({ event: 'begin', refits: 1 })
    stop()
  })

  it('holds the native activity for exactly the backfill', async () => {
    const { semanticSearch, activity } = await setup({ notes: 2 })

    const stop = semanticSearch.start()
    await vi.waitFor(() => expect(activity).toHaveLength(2))

    expect(activity).toEqual([
      { event: 'begin', reason: BACKFILL_ACTIVITY, refits: 1, embedded: 0 },
      { event: 'end', reason: BACKFILL_ACTIVITY, refits: 1, embedded: 2 },
    ])
    stop()
  })

  it('publishes the backfill position every few notes and clears it after', async () => {
    const { semanticSearch } = await setup({ notes: 25 })
    const published = publishedProgress(semanticSearch)

    const stop = semanticSearch.start()
    await vi.waitFor(() => expect(published.at(-1)).toBeNull())

    expect(published).toEqual([
      { done: 10, total: 25 },
      { done: 20, total: 25 },
      { done: 25, total: 25 },
      null,
    ])
    expect(semanticSearch.getIndexProgress()).toBeNull()
    stop()
  })

  it('logs a failing progress listener and still tells the others', async () => {
    const { semanticSearch, logger } = await setup({ notes: 10 })
    const failure = new Error('render failed')
    semanticSearch.subscribe(() => {
      throw failure
    })
    const published = publishedProgress(semanticSearch)

    const stop = semanticSearch.start()
    await vi.waitFor(() => expect(published).toEqual([{ done: 10, total: 10 }, null]))

    expect(logger.getErrors()).toEqual([
      { message: 'semantic index progress listener failed:', cause: failure },
      { message: 'semantic index progress listener failed:', cause: failure },
    ])
    stop()
  })

  it('waits for the index pass to settle before backfilling', async () => {
    const { semanticSearch, runtime, embeddingIndex, graphSession } = await setup({
      indexing: true,
    })

    const stop = semanticSearch.start()
    await vi.waitFor(() => expect(runtime.lastStatus()).toEqual(READY))
    await flush()
    expect(embeddingIndex.follows()).toEqual([])

    graphSession.setState({ indexing: false })
    expect(embeddingIndex.follows()).toEqual([{ generation: 7, modelId: MODEL }])
    stop()
  })

  it('stops following while a later index pass runs, and follows anew after it', async () => {
    const { semanticSearch, embeddingIndex, graphSession, indexLifecycle } = await setup()
    const stop = semanticSearch.start()
    await vi.waitFor(() => expect(embeddingIndex.follows()).toHaveLength(1))

    graphSession.setState({ indexing: true })
    indexLifecycle.emitApplied([{ kind: 'remove', path: 'notes/a.md' }], 7)
    await flush()
    expect(embeddingIndex.removed()).toEqual([])

    graphSession.setState({ indexing: false })
    expect(embeddingIndex.follows()).toEqual([
      { generation: 7, modelId: MODEL },
      { generation: 7, modelId: MODEL },
    ])
    stop()
  })

  it('embeds the notes of applied index batches while enabled and ready', async () => {
    const { semanticSearch, embeddingIndex, indexLifecycle } = await setup()
    const stop = semanticSearch.start()
    await vi.waitFor(() => expect(embeddingIndex.follows()).toHaveLength(1))

    indexLifecycle.emitApplied([{ kind: 'remove', path: 'notes/a.md' }], 7)

    await vi.waitFor(() =>
      expect(embeddingIndex.removed()).toEqual([{ path: 'notes/a.md', generation: 7 }]),
    )
    stop()
  })

  it('starts no model load and no embedding work while semantic search is disabled', async () => {
    const { semanticSearch, runtime, embeddingIndex } = await setup({ enabled: false })

    const stop = semanticSearch.start()
    await flush()

    expect(runtime.ensureCalls()).toBe(0)
    expect(embeddingIndex.follows()).toEqual([])
    stop()
  })

  it('loads the model the moment the setting flips on', async () => {
    const { semanticSearch, settings, runtime, embeddingIndex } = await setup({
      enabled: false,
      status: { status: 'uninitialized' },
    })
    const stop = semanticSearch.start()
    await flush()
    expect(runtime.ensureCalls()).toBe(0)

    settings.update({ semanticSearchEnabled: true })
    await vi.waitFor(() => expect(runtime.ensureCalls()).toBe(1))

    // The download ends: the backfill and the follow start by themselves.
    runtime.setStatus(READY)
    expect(embeddingIndex.follows()).toEqual([{ generation: 7, modelId: MODEL }])
    stop()
  })

  it('switches to the configured model instead of embedding with another', async () => {
    const { semanticSearch, runtime, embeddingIndex } = await setup({ model: GEMMA })

    const stop = semanticSearch.start()
    await vi.waitFor(() => expect(runtime.lastStatus()).toEqual(READY))
    await flush()

    // Only ever the configured model is asked for; the loaded one writes nothing.
    expect([...new Set(runtime.ensuredModels())]).toEqual([GEMMA])
    expect(embeddingIndex.prepares()).toEqual([])
    expect(embeddingIndex.follows()).toEqual([])

    // The switch lands: the table refits to the new model's width and re-embeds.
    runtime.setStatus({ status: 'ready', model: GEMMA, dims: 768 })
    expect(embeddingIndex.follows()).toEqual([{ generation: 7, modelId: GEMMA }])
    await vi.waitFor(() =>
      expect(embeddingIndex.prepares()).toEqual([{ model: GEMMA, dims: 768, generation: 7 }]),
    )
    stop()
  })

  it('pauses follow-up work the moment semantic search is disabled', async () => {
    const { semanticSearch, settings, embeddingIndex, indexLifecycle } = await setup()
    const stop = semanticSearch.start()
    await vi.waitFor(() => expect(embeddingIndex.follows()).toHaveLength(1))

    settings.update({ semanticSearchEnabled: false })
    // A batch still in flight when the teardown ran must be dropped, not
    // embedded behind the user's back.
    indexLifecycle.emitApplied([{ kind: 'remove', path: 'notes/b.md' }], 7)
    await flush()

    expect(embeddingIndex.removed()).toEqual([])
    stop()
  })

  it('never retries a failed load by itself', async () => {
    const { semanticSearch, runtime, embeddingIndex } = await setup({
      status: { status: 'failed', message: 'offline' },
    })

    const stop = semanticSearch.start()
    await vi.waitFor(() => expect(runtime.lastStatus().status).toBe('failed'))
    await flush()

    // The one load an untouched runtime gets; `failed` starts no second one.
    expect(runtime.ensureCalls()).toBe(1)
    expect(embeddingIndex.follows()).toEqual([])
    stop()
  })

  it('does nothing in a secondary note window', async () => {
    const { semanticSearch, runtime, embeddingIndex } = await setup({ role: 'note-window' })

    const stop = semanticSearch.start()
    await vi.waitFor(() => expect(runtime.lastStatus()).toEqual(READY))
    await flush()

    expect(runtime.ensureCalls()).toBe(0)
    expect(embeddingIndex.follows()).toEqual([])
    stop()
  })

  it('follows anew when another index session opens', async () => {
    const { semanticSearch, embeddingIndex, graphSession, indexLifecycle } = await setup()
    const stop = semanticSearch.start()
    await vi.waitFor(() => expect(embeddingIndex.follows()).toHaveLength(1))

    graphSession.setState({ indexGeneration: 8 })

    expect(embeddingIndex.follows()).toEqual([
      { generation: 7, modelId: MODEL },
      { generation: 8, modelId: MODEL },
    ])
    // The first follow is over: a late batch of its generation is dropped.
    indexLifecycle.emitApplied([{ kind: 'remove', path: 'notes/a.md' }], 7)
    await flush()
    expect(embeddingIndex.removed()).toEqual([])
    stop()
  })

  it('does not follow while no index session is open', async () => {
    const { semanticSearch, runtime, embeddingIndex, graphSession } = await setup()
    graphSession.setState({ indexGeneration: null })

    const stop = semanticSearch.start()
    await vi.waitFor(() => expect(runtime.lastStatus()).toEqual(READY))
    await flush()

    expect(embeddingIndex.follows()).toEqual([])
    stop()
  })

  it('reacts to nothing once stopped', async () => {
    const { semanticSearch, settings, runtime, embeddingIndex } = await setup({ enabled: false })
    const stop = semanticSearch.start()
    await flush()
    stop()

    settings.update({ semanticSearchEnabled: true })
    await flush()

    expect(runtime.ensureCalls()).toBe(0)
    expect(embeddingIndex.follows()).toEqual([])
    expect(semanticSearch.running()).toBe(0)
  })
})

describe('retryFailedModel', () => {
  it('re-kicks a failed load of the configured model', async () => {
    const { semanticSearch, runtime } = await setup({
      model: GEMMA,
      status: { status: 'failed', message: 'offline' },
    })
    await semanticSearch.retryFailedModel()
    expect(runtime.ensuredModels()).toEqual([GEMMA])
  })

  it('is a no-op for any other status', async () => {
    const { semanticSearch, runtime } = await setup()
    await semanticSearch.retryFailedModel()
    expect(runtime.ensureCalls()).toBe(0)
  })
})

describe('ensureModel', () => {
  it('loads the configured model', async () => {
    const { semanticSearch, runtime } = await setup({
      model: GEMMA,
      status: { status: 'unsupported' },
    })
    await semanticSearch.ensureModel()
    expect(runtime.ensuredModels()).toEqual([GEMMA])
  })

  it('resolves at once when the platform has no embedding runtime', async () => {
    const { semanticSearch } = await setup({ status: { status: 'unsupported' } })
    await expect(semanticSearch.ensureModel()).resolves.toEqual({ status: 'unsupported' })
  })

  it('resolves only at a terminal status (a racing ensure returns loading)', async () => {
    // Someone else is mid-download: ensure and the re-poll both answer loading.
    const { semanticSearch, runtime } = await setup({ status: { status: 'loading' } })

    let settled = false
    const pending = semanticSearch.ensureModel().then((status) => {
      settled = true
      return status
    })
    await vi.waitFor(() => expect(runtime.ensureCalls()).toBe(1))
    expect(settled).toBe(false)

    runtime.setStatus(READY)
    await expect(pending).resolves.toEqual(READY)
  })

  it('returns a failed status when the load fails', async () => {
    const { semanticSearch } = await setup({
      status: { status: 'failed', message: 'no disk space' },
    })
    const status = await semanticSearch.ensureModel()
    expect(status).toEqual({ status: 'failed', message: 'no disk space' })
  })
})

describe('similarNotes', () => {
  it('asks for the six nearest neighbors of the note', async () => {
    const hit: RetrievalHit = {
      path: 'notes/a.md',
      title: 'A',
      score: 0.9,
      snippet: '',
      heading: null,
      isPrivate: false,
      hasConflict: false,
    }
    const { semanticSearch, retrieval } = await setup({ relatedNotes: () => [hit] })

    await expect(semanticSearch.similarNotes('notes/x.md')).resolves.toEqual([hit])

    expect(retrieval.relatedNotesCalls()).toEqual([{ path: 'notes/x.md', limit: 6 }])
  })
})

describe('after an index rebuild', () => {
  it('re-embeds nothing while the model is not ready', async () => {
    const { indexLifecycle, embeddingIndex } = await setup({ status: { status: 'uninitialized' } })

    await indexLifecycle.rebuildVisibly()

    expect(indexLifecycle.rebuilds()).toEqual([7])
    expect(embeddingIndex.backfills()).toEqual([])
  })

  it('re-runs the embedding backfill when the model is ready', async () => {
    const { indexLifecycle, embeddingIndex } = await setup()

    await indexLifecycle.rebuildVisibly()
    await indexLifecycle.rebuildVisibly()

    // index_clear wiped the embedding tables; each rebuild repopulates them once.
    expect(embeddingIndex.backfills()).toEqual([
      { generation: 7, modelId: MODEL },
      { generation: 7, modelId: MODEL },
    ])
  })

  it("keeps the open graph's local-only notes private in the re-embed", async () => {
    const localOnly: LocalOnlyFolders[] = []
    const { indexLifecycle } = await setup({
      localOnlyFolders: ['secure'],
      backfill: async (backfillOptions) => {
        localOnly.push(backfillOptions.localOnly)
        return 'completed'
      },
    })

    await indexLifecycle.rebuildVisibly()

    expect(localOnly.map((folders) => isLocalOnlyPath(folders, 'secure/plan.md'))).toEqual([true])
  })

  it('re-embeds nothing once another graph session replaced the rebuilt one', async () => {
    const { indexLifecycle, embeddingIndex } = await setup({ graphGeneration: 2 })

    await indexLifecycle.rebuildVisibly()

    expect(embeddingIndex.backfills()).toEqual([])
  })

  it('keeps the rebuild request in flight until the backfill ends', async () => {
    const backfill = Promise.withResolvers<EmbeddingBackfillResult>()
    const { indexLifecycle, embeddingIndex } = await setup({ backfill: () => backfill.promise })

    let settled = false
    const first = indexLifecycle.rebuildVisibly().then(() => {
      settled = true
    })
    await vi.waitFor(() => expect(embeddingIndex.backfills()).toHaveLength(1))
    // A request made meanwhile coalesces onto the pass, its re-embed included.
    const second = indexLifecycle.rebuildVisibly()
    await flush()
    expect(settled).toBe(false)

    backfill.resolve('completed')
    await Promise.all([first, second])
    expect(embeddingIndex.backfills()).toHaveLength(1)
  })

  it('re-embeds nothing after a failed rebuild', async () => {
    const { indexLifecycle, embeddingIndex, progress } = await setup({ failClear: true })

    await expect(indexLifecycle.rebuildVisibly()).resolves.toBeUndefined()

    expect(progress.findByLabel('Rebuilding search index')?.status).toBe('failed')
    expect(embeddingIndex.backfills()).toEqual([])
  })

  it('re-embeds nothing after a background sync pass', async () => {
    const { indexLifecycle, embeddingIndex } = await setup()

    indexLifecycle.sync(
      createGraphSession({ root: '/g', name: 'g', generation: 1, indexGeneration: 7 }),
    )
    await indexLifecycle.settled()

    expect(embeddingIndex.backfills()).toEqual([])
    await indexLifecycle.close()
  })

  it('stops re-embedding once disposed', async () => {
    const { semanticSearch, indexLifecycle, embeddingIndex } = await setup()
    semanticSearch.dispose()

    await indexLifecycle.rebuildVisibly()

    expect(embeddingIndex.backfills()).toEqual([])
  })
})
