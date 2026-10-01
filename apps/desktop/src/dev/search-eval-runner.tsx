import { useEffect } from 'react'
import { z } from 'zod'
import { call, embedStatus, errorMessage, retrieve, withActivity } from '@reflect/core'
import { useGraph } from '@/providers/graph-provider.tsx'

/**
 * Dev builds only: scores the search the app actually serves. Start the dev
 * app with `VITE_SEARCH_EVAL=1 REFLECT_SEARCH_EVAL=/path/job.json` (and
 * `REFLECT_DEV_CONFIG_DIR` to keep it off the installed app's state); once that
 * file appears, every
 * query runs through `retrieve` in each requested mode and the ranked paths
 * land in `job.results.json` (`dev_harness.rs`). Whoever writes the job waits
 * for the index and embeddings first, so a run never races the first pass.
 */

const POLL_MS = 2000

const jobSchema = z.object({
  limit: z.number().int().positive(),
  modes: z.array(z.enum(['lexical', 'semantic', 'hybrid'])),
  /** Replace the model's noise cutoff (`2` keeps every neighbor), to calibrate it. */
  maxDistance: z.number().positive().optional(),
  queries: z.array(z.object({ id: z.number().int(), query: z.string() })),
})
type SearchEvalJob = z.infer<typeof jobSchema>

interface QueryResult {
  id: number
  mode: SearchEvalJob['modes'][number]
  ms: number
  paths: string[]
  /** Each hit's score: cosine similarity in semantic mode. */
  scores: number[]
  error?: string
}

async function runJob(job: SearchEvalJob): Promise<void> {
  const embed = await embedStatus().catch(() => null)
  const results: QueryResult[] = []
  for (const mode of job.modes) {
    for (const { id, query } of job.queries) {
      const started = performance.now()
      try {
        const hits = await retrieve(query, {
          mode,
          limit: job.limit,
          ...(job.maxDistance === undefined ? {} : { maxDistance: job.maxDistance }),
        })
        results.push({
          id,
          mode,
          ms: performance.now() - started,
          paths: hits.map((hit) => hit.path),
          scores: hits.map((hit) => hit.score),
        })
      } catch (cause) {
        results.push({
          id,
          mode,
          ms: performance.now() - started,
          paths: [],
          scores: [],
          error: errorMessage(cause),
        })
      }
    }
  }
  await call(
    'dev_search_eval_finish',
    {
      results: {
        embed,
        maxDistance: job.maxDistance ?? null,
        results,
      },
    },
    z.null(),
  )
}

export function SearchEvalRunner(): null {
  const { status, indexGeneration } = useGraph()

  useEffect(() => {
    if (status !== 'ready' || indexGeneration === null) {
      return
    }
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async (): Promise<void> => {
      try {
        const job = await call('dev_search_eval_poll', {}, jobSchema.nullable())
        if (job !== null && !stopped) {
          // Napped, a hidden app would run (and time) every query at background priority.
          await withActivity('Running a search eval', () => runJob(job))
        }
      } catch (cause) {
        console.error('search eval failed:', errorMessage(cause))
      }
      if (!stopped) {
        timer = setTimeout(() => void tick(), POLL_MS)
      }
    }
    timer = setTimeout(() => void tick(), POLL_MS)
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [status, indexGeneration])

  return null
}
