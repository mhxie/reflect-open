import { z } from 'zod'
import type { EmbeddingRuntimeService } from '../embeddings/embedding-runtime-service.ts'
import type { RetrievalService } from '../embeddings/retrieval-service.ts'
import { errorMessage } from '../errors.ts'
import type { IpcBridgeService } from '../ipc/ipc-service.ts'
import type { ClockService } from '../ports/clock-service.ts'
import type { NativeActivityService } from './native-activity-service.ts'

const searchEvalJobSchema = z.object({
  limit: z.number().int().positive(),
  modes: z.array(z.enum(['lexical', 'semantic', 'hybrid'])),
  /**
   * Replace the model's noise cutoff (`2` keeps every neighbor), to calibrate it.
   */
  maxDistance: z.number().positive().optional(),
  queries: z.array(z.object({ id: z.number().int(), query: z.string() })),
})

/**
 * One scoring job the dev harness hands the app: queries to run in each mode.
 */
export type SearchEvalJob = z.infer<typeof searchEvalJobSchema>

/**
 * One query's ranked answer in one mode, as the harness reads it back.
 */
interface SearchEvalQueryResult {
  id: number
  mode: SearchEvalJob['modes'][number]
  ms: number
  paths: string[]
  /**
   * Each hit's score: cosine similarity in semantic mode.
   */
  scores: number[]
  error?: string
}

const voidSchema = z.null()

/**
 * Dev builds only: scores the search the app actually serves. A dev app
 * started with `VITE_SEARCH_EVAL=1 REFLECT_SEARCH_EVAL=/path/job.json` (and
 * `REFLECT_DEV_CONFIG_DIR` to keep it off the installed app's state) gets the
 * job from the harness (`dev_harness.rs`) once that file appears, and every
 * query runs through `retrieve` in each requested mode; the ranked paths land
 * in `job.results.json`. Whoever writes the job waits for the index and
 * embeddings first, so a run never races the first pass.
 */
export interface SearchEvalService {
  /**
   * The job the harness has waiting, or null.
   */
  poll(): Promise<SearchEvalJob | null>
  /**
   * Run every query of `job` in each of its modes and hand the results back
   * to the harness. A failed query records its error and the run goes on.
   * Holds off App Nap meanwhile: napped, a hidden app would run (and time)
   * every query at background priority.
   */
  run(job: SearchEvalJob): Promise<void>
}

export interface SearchEvalServiceDeps {
  readonly ipc: IpcBridgeService
  readonly retrieval: RetrievalService
  readonly embeddingRuntime: EmbeddingRuntimeService
  readonly nativeActivity: NativeActivityService
  readonly clock: ClockService
}

class SearchEvalServiceImpl implements SearchEvalService {
  readonly #deps: SearchEvalServiceDeps

  constructor(deps: SearchEvalServiceDeps) {
    this.#deps = deps
  }

  async poll(): Promise<SearchEvalJob | null> {
    return await this.#deps.ipc.call('dev_search_eval_poll', {}, searchEvalJobSchema.nullable())
  }

  async run(job: SearchEvalJob): Promise<void> {
    await this.#deps.nativeActivity.run('Running a search eval', () => this.#score(job))
  }

  async #score(job: SearchEvalJob): Promise<void> {
    const { ipc, retrieval, embeddingRuntime, clock } = this.#deps
    const embed = await embeddingRuntime.status().catch(() => null)
    const results: SearchEvalQueryResult[] = []
    for (const mode of job.modes) {
      for (const { id, query } of job.queries) {
        const started = clock.monotonicNow()
        try {
          const hits = await retrieval.retrieve(query, {
            mode,
            limit: job.limit,
            ...(job.maxDistance === undefined ? {} : { maxDistance: job.maxDistance }),
          })
          results.push({
            id,
            mode,
            ms: clock.monotonicNow() - started,
            paths: hits.map((hit) => hit.path),
            scores: hits.map((hit) => hit.score),
          })
        } catch (cause) {
          results.push({
            id,
            mode,
            ms: clock.monotonicNow() - started,
            paths: [],
            scores: [],
            error: errorMessage(cause),
          })
        }
      }
    }
    await ipc.call(
      'dev_search_eval_finish',
      { results: { embed, maxDistance: job.maxDistance ?? null, results } },
      voidSchema,
    )
  }
}

/**
 * The search eval over the dev harness commands.
 */
export function createSearchEvalService(deps: SearchEvalServiceDeps): SearchEvalService {
  return new SearchEvalServiceImpl(deps)
}
