import type { NativeActivityService } from '../app/native-activity-service.ts'
import type { GraphRole } from '../graph/graph-session.ts'
import type { LoggerService } from '../ports/logger-service.ts'
import type { StorageService } from '../ports/storage-service.ts'
import type { GraphSessionState } from '../graph/graph-session-service.ts'
import type { IndexLifecycleService } from '../indexing/index-lifecycle-service.ts'
import type { Unlisten } from '../unlisten.ts'
import type { SettingsService } from '../settings/settings-service.ts'
import type { EmbeddingBackfillResult, EmbeddingIndexService } from './embedding-index-service.ts'
import type { EmbeddingRuntimeService, EmbedStatus } from './embedding-runtime-service.ts'
import type { RetrievalHit, RetrievalService } from './retrieval-service.ts'

/**
 * Where the opt-in lived before it moved into the settings document.
 */
const LEGACY_ENABLED_KEY = 'reflect.semantic.enabled'

const SIMILAR_NOTES_LIMIT = 6

/**
 * Backfill progress is published every this many notes: smooth, not a render per note.
 */
const PROGRESS_STEP = 10

/**
 * Why the native activity is held while a backfill runs (macOS shows it to the user).
 */
const BACKFILL_ACTIVITY = 'Embedding notes for semantic search'

/**
 * The open graph as {@link SemanticSearchService} reads it; a `GraphSessionService` is one.
 */
export interface SemanticSearchGraphSource {
  getState: () => Pick<GraphSessionState, 'graph' | 'indexGeneration' | 'indexing' | 'session'>
  subscribe: (listener: () => void) => Unlisten
}

/**
 * How far the running embedding backfill has walked the graph's notes.
 */
export interface SemanticIndexProgress {
  readonly done: number
  readonly total: number
}

/**
 * The user-facing side of the optional local semantic search (Plan 09). The
 * model downloads from the network, so it is **opt-in**: the
 * `semanticSearchEnabled` setting is the persisted opt-in, and a started
 * service kicks the first download; later launches auto-load from the local
 * cache because the flag is set. Which model loads is the `semanticModel`
 * setting; choosing another one loads it and re-embeds the graph into a
 * vector table of its width. Acceptance: "first semantic use downloads the
 * model with progress; later uses are instant."
 *
 * From its creation the service also re-embeds after each requested index
 * rebuild (`IndexLifecycleService.onReconciled` with `source: 'rebuild'`):
 * `index_clear` wiped the embedding tables with everything else, and semantic
 * search would otherwise stay silently empty until some other trigger
 * re-embedded. The rebuild request stays in flight until that backfill ends.
 */
export interface SemanticSearchService {
  /**
   * Calls `listener` whenever {@link SemanticSearchService.getIndexProgress} changes.
   */
  subscribe: (listener: () => void) => Unlisten
  /**
   * How far the running backfill has walked the graph's notes, or `null`
   * when none runs: the search settings show it, so a model switch, which
   * re-embeds every note, reads as progress rather than silence.
   */
  getIndexProgress: () => SemanticIndexProgress | null
  /**
   * Keep embeddings in sync with the open graph until the returned function
   * is called. Three jobs:
   *
   * - load the configured model whenever `semanticSearchEnabled` is on and the
   *   runtime is untouched or holds another model — at launch for users who
   *   opted in earlier (the cache makes that instant), the moment the setting
   *   flips on (the one place the first download starts), and when the model
   *   setting changes. Deliberately not retried on `failed`: an automatic
   *   loop would hammer a broken download — recovery rides the explicit
   *   enable/retry actions instead (see
   *   {@link SemanticSearchService.retryFailedModel});
   * - once the configured model is `ready` and the index pass has settled,
   *   refit the vector table to the model and run one incremental backfill
   *   per (graph, model) (hash-skip makes this cheap when nothing changed),
   *   publishing its progress and holding the native activity, so a hidden
   *   window's re-embed is not throttled. The backfill reads the note list
   *   once, so a pass starting later tears it down, and the hash-skip makes
   *   the rerun after it cheap;
   * - follow the index: changed notes re-embed, deleted notes drop vectors.
   *
   * Backfill and follow work need the runtime `ready` with the configured
   * model *and* the setting on: until a switch lands, the previous model must
   * not write vectors into the table; disabling semantic search pauses
   * embedding work immediately (the loaded model just idles for the rest of
   * the session), and re-enabling catches up via the cheap hash-skip backfill.
   * Main window only: a secondary note window loading the model and
   * re-embedding on the same watcher stream would duplicate every write.
   *
   * Starting also carries the opt-in over from where it lived before the
   * settings document (`localStorage`), once, so those users keep semantic
   * search across the move.
   */
  start(): Unlisten
  /**
   * Load (downloading if needed) the configured model. Resolves with the outcome.
   */
  ensureModel(): Promise<EmbedStatus>
  /**
   * Re-kick a `failed` load of the configured model; a no-op for every other
   * status. The explicit enable actions (settings button, `semantic.enable`
   * command) run this so opting back in after a failure retries the download
   * — a started service itself only loads an `uninitialized` runtime (or one
   * holding another model), because reacting to `failed` would loop a broken
   * download forever.
   */
  retryFailedModel(): Promise<void>
  /**
   * The semantic neighbors of the note at `path` ("Similar notes"), at most
   * six. A costly read (see `RetrievalService.relatedNotes`): callers own
   * their refresh cadence.
   */
  similarNotes(path: string): Promise<RetrievalHit[]>
  /**
   * Stop re-embedding after index rebuilds. The service is unusable afterwards.
   */
  dispose(): void
}

export interface SemanticSearchServiceDeps {
  readonly embeddingRuntime: EmbeddingRuntimeService
  readonly embeddingIndex: EmbeddingIndexService
  readonly retrieval: RetrievalService
  readonly settings: SettingsService
  readonly storage: StorageService
  readonly nativeActivity: NativeActivityService
  readonly role: GraphRole
  readonly indexLifecycle: IndexLifecycleService
  readonly graphSession: SemanticSearchGraphSource
  readonly logger: LoggerService
}

class SemanticSearchServiceImpl implements SemanticSearchService {
  readonly #deps: SemanticSearchServiceDeps
  readonly #stopFollowingRebuilds: () => void
  readonly #mainWindow: boolean
  readonly #listeners = new Set<() => void>()
  #progress: SemanticIndexProgress | null = null

  constructor(deps: SemanticSearchServiceDeps) {
    this.#deps = deps
    this.#mainWindow = deps.role === 'main'
    const { embeddingRuntime, embeddingIndex, indexLifecycle, graphSession } = deps
    this.#stopFollowingRebuilds = indexLifecycle.onReconciled(
      async ({ generation, fileGeneration, source }) => {
        if (source !== 'rebuild') {
          return
        }
        const { session } = graphSession.getState()
        const embed = await embeddingRuntime.status()
        if (embed.status === 'ready' && session !== null && session.generation === fileGeneration) {
          await embeddingIndex.backfill({
            generation,
            fileGeneration,
            modelId: embed.model,
            localOnly: session.localOnly,
          })
        }
      },
    )
  }

  readonly subscribe = (listener: () => void): Unlisten => {
    // Wrapped for identity, so one function added twice detaches independently.
    const deliver = (): void => {
      listener()
    }
    this.#listeners.add(deliver)
    return () => {
      this.#listeners.delete(deliver)
    }
  }

  readonly getIndexProgress = (): SemanticIndexProgress | null => this.#progress

  start(): Unlisten {
    const { embeddingRuntime, embeddingIndex, settings, graphSession, nativeActivity, logger } =
      this.#deps
    if (this.#consumeLegacyOptIn()) {
      settings.update({ semanticSearchEnabled: true })
    }

    let stopped = false
    // What each reaction last ran for: a reaction reruns only when its own
    // inputs change, not on every notification of every source.
    let loadGate: string | null = null
    let followed: string | null = null
    let stopFollowing: Unlisten | null = null

    const react = (): void => {
      if (stopped) {
        return
      }
      const current = settings.get()
      const enabled = current.semanticSearchEnabled && this.#mainWindow
      const wanted = current.semanticModel
      const status = embeddingRuntime.lastStatus()
      const loadedModel = status.status === 'ready' ? status.model : null

      const nextLoadGate = `${enabled} ${status.status} ${loadedModel ?? ''} ${wanted}`
      if (nextLoadGate !== loadGate) {
        loadGate = nextLoadGate
        if (
          enabled &&
          (status.status === 'uninitialized' || (loadedModel !== null && loadedModel !== wanted))
        ) {
          void this.ensureModel()
        }
      }

      // embed_apply/embed_remove are gated on the INDEX session generation, not
      // the file-write generation in GraphInfo — the counters are independent.
      // Ready means ready with the configured model: until a switch lands,
      // the previous model must not write vectors into the table.
      const { graph, indexGeneration: generation, indexing, session } = graphSession.getState()
      const loaded = status.status === 'ready' && status.model === wanted ? status : null
      const target =
        enabled &&
        loaded !== null &&
        !indexing &&
        generation !== null &&
        graph !== null &&
        session !== null
          ? {
              generation,
              fileGeneration: graph.generation,
              modelId: loaded.model,
              dims: loaded.dims,
              root: graph.root,
            }
          : null
      const next = target === null ? null : JSON.stringify(target)
      if (next !== followed) {
        // `enabled` is part of the gate so a mid-session disable tears the
        // follow down: its queued work skips and its subscription drops.
        followed = next
        stopFollowing?.()
        stopFollowing =
          target === null || session === null
            ? null
            : embeddingIndex.follow({
                generation: target.generation,
                fileGeneration: target.fileGeneration,
                modelId: target.modelId,
                dims: target.dims,
                localOnly: session.localOnly,
                onProgress: (done, total) => {
                  if (done === total || done % PROGRESS_STEP === 0) {
                    this.#setProgress({ done, total })
                  }
                },
                // A switch re-embeds the whole graph, often with the window hidden.
                runBackfill: async (backfill): Promise<EmbeddingBackfillResult> => {
                  try {
                    return await nativeActivity.run(BACKFILL_ACTIVITY, backfill)
                  } finally {
                    this.#setProgress(null)
                  }
                },
              })
      }
    }

    const unlisteners = [
      settings.subscribe(react),
      embeddingRuntime.subscribe(react),
      graphSession.subscribe(react),
    ]
    // A later start reads the last status the runtime observed; the first one polls.
    embeddingRuntime.status().catch((cause: unknown) => {
      logger.warn('failed to poll the embedding runtime status', cause)
    })
    react()

    return () => {
      stopped = true
      for (const unlisten of unlisteners) {
        unlisten()
      }
      stopFollowing?.()
      stopFollowing = null
    }
  }

  async ensureModel(): Promise<EmbedStatus> {
    const { embeddingRuntime, settings } = this.#deps
    try {
      return await embeddingRuntime.awaitTerminalStatus(
        await embeddingRuntime.ensure(settings.get().semanticModel),
      )
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      return { status: 'failed', message }
    }
  }

  async retryFailedModel(): Promise<void> {
    const { embeddingRuntime, settings } = this.#deps
    await embeddingRuntime.retry(settings.get().semanticModel)
  }

  similarNotes(path: string): Promise<RetrievalHit[]> {
    return this.#deps.retrieval.relatedNotes(path, SIMILAR_NOTES_LIMIT)
  }

  dispose(): void {
    this.#stopFollowingRebuilds()
  }

  #setProgress(next: SemanticIndexProgress | null): void {
    if (next === this.#progress) {
      return
    }
    this.#progress = next
    for (const listener of this.#listeners) {
      try {
        listener()
      } catch (cause) {
        this.#deps.logger.error('semantic index progress listener failed:', cause)
      }
    }
  }

  /**
   * Read-and-clear the pre-settings localStorage opt-in. Returns true exactly
   * once for a user who enabled semantic search before the flag moved into
   * settings — the caller persists it there and the key never matters again.
   */
  #consumeLegacyOptIn(): boolean {
    const local = this.#deps.storage.local
    const enabled = local.get(LEGACY_ENABLED_KEY) === 'true'
    local.set(LEGACY_ENABLED_KEY, null)
    return enabled
  }
}

export function createSemanticSearchService(
  deps: SemanticSearchServiceDeps,
): SemanticSearchService {
  return new SemanticSearchServiceImpl(deps)
}
