import { describe, expect, it } from 'vitest'
import { AppError } from '../errors.ts'
import { createTestClockService } from '../testing/clock.ts'
import {
  createTestEmbeddingRuntimeService,
  createTestRetrievalService,
} from '../testing/embeddings.ts'
import { createTestIpcBridgeService } from '../testing/ipc.ts'
import { createNativeActivityService } from './native-activity-service.ts'
import { createSearchEvalService, type SearchEvalJob } from './search-eval-service.ts'

const JOB: SearchEvalJob = {
  limit: 3,
  modes: ['lexical', 'semantic'],
  queries: [
    { id: 1, query: 'local-first' },
    { id: 2, query: 'broken' },
  ],
}

function setup(job: SearchEvalJob | null = JOB) {
  const finished: unknown[] = []
  const ipc = createTestIpcBridgeService({
    commands: {
      dev_search_eval_poll: () => job,
      dev_search_eval_finish: (args) => {
        finished.push(args['results'])
        return null
      },
      activity_begin: () => 'activity-1',
      activity_end: () => null,
    },
  })
  const retrieval = createTestRetrievalService({
    retrieve: (query, options) => {
      if (query === 'broken') {
        throw new AppError('io', 'index unavailable')
      }
      return [
        {
          path: `notes/${options?.mode ?? 'hybrid'}.md`,
          title: 'Hit',
          score: 0.9,
          snippet: '',
          heading: null,
          isPrivate: false,
        },
      ]
    },
  })
  const searchEval = createSearchEvalService({
    ipc,
    retrieval,
    embeddingRuntime: createTestEmbeddingRuntimeService(),
    nativeActivity: createNativeActivityService({ ipc }),
    clock: createTestClockService(),
  })
  return { ipc, retrieval, searchEval, finished }
}

describe('SearchEvalService', () => {
  it('polls the harness for a waiting job', async () => {
    await expect(setup().searchEval.poll()).resolves.toEqual(JOB)
    await expect(setup(null).searchEval.poll()).resolves.toBeNull()
  })

  it('runs every query in every mode and hands the ranked paths back', async () => {
    const { ipc, retrieval, searchEval, finished } = setup()

    await searchEval.run(JOB)

    expect(retrieval.retrieveCalls()).toEqual([
      { query: 'local-first', options: { mode: 'lexical', limit: 3 } },
      { query: 'broken', options: { mode: 'lexical', limit: 3 } },
      { query: 'local-first', options: { mode: 'semantic', limit: 3 } },
      { query: 'broken', options: { mode: 'semantic', limit: 3 } },
    ])
    expect(finished).toEqual([
      {
        embed: { status: 'ready', model: 'all-MiniLM-L6-v2', dims: 384 },
        maxDistance: null,
        results: [
          { id: 1, mode: 'lexical', ms: 0, paths: ['notes/lexical.md'], scores: [0.9] },
          { id: 2, mode: 'lexical', ms: 0, paths: [], scores: [], error: 'index unavailable' },
          { id: 1, mode: 'semantic', ms: 0, paths: ['notes/semantic.md'], scores: [0.9] },
          { id: 2, mode: 'semantic', ms: 0, paths: [], scores: [], error: 'index unavailable' },
        ],
      },
    ])
    // The whole run holds the App Nap activity.
    expect(ipc.calls().map((call) => call.command)).toEqual([
      'activity_begin',
      'dev_search_eval_finish',
      'activity_end',
    ])
  })

  it('passes a calibration cutoff through to every query', async () => {
    const { retrieval, searchEval, finished } = setup()

    await searchEval.run({ ...JOB, modes: ['semantic'], maxDistance: 2 })

    expect(retrieval.retrieveCalls().map((call) => call.options)).toEqual([
      { mode: 'semantic', limit: 3, maxDistance: 2 },
      { mode: 'semantic', limit: 3, maxDistance: 2 },
    ])
    expect(finished).toMatchObject([{ maxDistance: 2 }])
  })
})
