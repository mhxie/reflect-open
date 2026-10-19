import { describe, expect, it } from 'vitest'
import { AppError } from '../errors.ts'
import type { GraphRole } from '../graph/graph-session.ts'
import {
  createTestEmbeddingRuntimeService,
  createTestGraphSessionService,
  createTestIpcBridgeService,
  createTestLoggerService,
  createTestPlatformService,
  createTestRetrievalService,
  createTestSettingsService,
  type TestOpenGraph,
} from '../testing/index.ts'
import type { EmbedStatus } from './embedding-runtime-service.ts'
import type { RetrievalHit, RetrieveOptions } from './retrieval-service.ts'
import { createSearchIpcService, type SearchIpcRequest } from './search-ipc-service.ts'

const READY: EmbedStatus = { status: 'ready', model: 'all-MiniLM-L6-v2', dims: 384 }

function hit(path: string, overrides?: Partial<RetrievalHit>): RetrievalHit {
  return {
    path,
    title: path,
    score: 1 / 61,
    snippet: `about ${path}`,
    heading: null,
    isPrivate: false,
    ...overrides,
  }
}

/**
 * One public note and two restricted ones; the restricted rank first with `privateFirst`.
 */
function hits(privateFirst = false): RetrievalHit[] {
  const rows = [
    hit('notes/public.md', { title: 'Public', snippet: 'a \u{1}wombat\u{2} note' }),
    hit('notes/secret.md', { title: 'Secret', snippet: '', isPrivate: true }),
    hit('notes/ocr.md', { title: 'OCR sentinel', snippet: '', hasDeviceOnlyContent: true }),
  ]
  return privateFirst ? [rows[1]!, rows[0]!, rows[2]!] : rows
}

interface SetupOptions {
  semantic?: boolean
  status?: EmbedStatus
  results?: RetrievalHit[] | (() => Promise<RetrievalHit[]>)
  graph?: TestOpenGraph | null
  role?: GraphRole
  mobile?: boolean
}

async function setup(options: SetupOptions = {}) {
  const settings = createTestSettingsService({ semanticSearchEnabled: options.semantic ?? true })
  settings.get()
  await settings.whenLoaded()
  const retrieveCalls: Array<RetrieveOptions | undefined> = []
  const ipc = createTestIpcBridgeService({
    commands: {
      search_ipc_start: () => null,
      search_ipc_stop: () => null,
      search_ipc_respond: () => null,
    },
  })
  const graphSession = createTestGraphSessionService({
    graph: options.graph === undefined ? {} : options.graph,
  })
  const logger = createTestLoggerService()
  const results = options.results ?? hits()
  const searchIpc = createSearchIpcService({
    ipc,
    retrieval: createTestRetrievalService({
      retrieve: async (_query, retrieveOptions) => {
        retrieveCalls.push(retrieveOptions)
        return typeof results === 'function' ? await results() : results
      },
    }),
    embeddingRuntime: createTestEmbeddingRuntimeService({ status: options.status ?? READY }),
    settings,
    platform: createTestPlatformService(
      options.mobile === true ? { appPlatform: 'ios' } : undefined,
    ),
    role: options.role ?? 'main',
    graphSession,
    logger,
  })
  const commands = (): string[] => ipc.calls().map((call) => call.command)
  return { searchIpc, ipc, graphSession, logger, retrieveCalls, commands }
}

const REQUEST: SearchIpcRequest = { id: 1, query: 'wombat', mode: 'hybrid', limit: 10 }

describe('answer', () => {
  it('never lets a private note reach the CLI, not even its path', async () => {
    const { searchIpc } = await setup()

    const answer = await searchIpc.answer(REQUEST)

    expect(answer).toEqual({
      mode: 'hybrid',
      results: [
        { path: 'notes/public.md', title: 'Public', snippet: 'a wombat note', score: 1 / 61 },
      ],
    })
  })

  it('drops a note inside a local-only folder, whatever its flags say', async () => {
    const { searchIpc } = await setup({
      graph: { localOnlyFolders: ['secure'] },
      results: [hit('finance/secure/plan.md'), hit('notes/public.md')],
    })

    const answer = await searchIpc.answer(REQUEST)

    expect(answer).toMatchObject({ results: [{ path: 'notes/public.md' }] })
  })

  it('answers with nothing when no graph is open', async () => {
    const { searchIpc } = await setup({ graph: null })

    await expect(searchIpc.answer(REQUEST)).resolves.toEqual({ mode: 'hybrid', results: [] })
  })

  it('over-fetches so dropped private hits still leave a full page', async () => {
    const { searchIpc, retrieveCalls } = await setup({ semantic: false, results: hits(true) })

    const answer = await searchIpc.answer({ ...REQUEST, limit: 1 })

    expect(answer).toMatchObject({ results: [{ path: 'notes/public.md' }] })
    expect(retrieveCalls).toEqual([{ mode: 'lexical', limit: 2, excludePrivateContent: true }])
  })

  it('answers lexically, and says so, when semantic search is off or not loaded', async () => {
    const notLoaded = await setup({ status: { status: 'uninitialized' } })
    await expect(notLoaded.searchIpc.answer(REQUEST)).resolves.toMatchObject({ mode: 'lexical' })
    expect(notLoaded.retrieveCalls.map((call) => call?.mode)).toEqual(['lexical'])

    const turnedOff = await setup({ semantic: false })
    await expect(turnedOff.searchIpc.answer(REQUEST)).resolves.toMatchObject({ mode: 'lexical' })
    expect(turnedOff.retrieveCalls.map((call) => call?.mode)).toEqual(['lexical'])
  })

  it('runs the requested mode when semantic search is on and loaded', async () => {
    const { searchIpc, retrieveCalls } = await setup()

    await searchIpc.answer({ ...REQUEST, mode: 'semantic' })

    expect(retrieveCalls.map((call) => call?.mode)).toEqual(['semantic'])
  })

  it('reports a failure as an error answer instead of throwing', async () => {
    const { searchIpc } = await setup({
      results: () => Promise.reject(new AppError('io', 'the index is closed')),
    })

    await expect(searchIpc.answer({ ...REQUEST, mode: 'lexical' })).resolves.toEqual({
      error: 'the index is closed',
    })
  })
})

describe('start', () => {
  it('serves the open graph and answers each request through retrieval', async () => {
    const { searchIpc, ipc, commands } = await setup()

    const stop = searchIpc.start()
    await expect.poll(commands).toContain('search_ipc_start')
    ipc.emit('search-ipc:request', { id: 7, query: 'wombat', mode: 'hybrid', limit: 10 })

    await expect
      .poll(() => ipc.calls().find((call) => call.command === 'search_ipc_respond'))
      .toEqual({
        command: 'search_ipc_respond',
        args: {
          id: 7,
          answer: {
            mode: 'hybrid',
            results: [
              { path: 'notes/public.md', title: 'Public', snippet: 'a wombat note', score: 1 / 61 },
            ],
          },
        },
      })
    stop()
  })

  it('stops serving when stopped, and answers nothing afterwards', async () => {
    const { searchIpc, ipc, commands } = await setup()

    const stop = searchIpc.start()
    await expect.poll(commands).toContain('search_ipc_start')
    stop()
    ipc.emit('search-ipc:request', { id: 8, query: 'wombat', mode: 'lexical', limit: 1 })

    await expect.poll(commands).toContain('search_ipc_stop')
    expect(commands()).not.toContain('search_ipc_respond')
  })

  it('serves nothing without an open graph, and starts once one opens', async () => {
    const { searchIpc, graphSession, commands } = await setup({ graph: null })

    const stop = searchIpc.start()
    expect(commands()).toEqual([])

    graphSession.setGraph({ root: '/graphs/next' })
    await expect.poll(commands).toContain('search_ipc_start')
    stop()
  })

  it('closes the socket when the graph closes or another opens', async () => {
    const { searchIpc, graphSession, commands } = await setup()

    const stop = searchIpc.start()
    await expect.poll(commands).toContain('search_ipc_start')
    graphSession.setGraph({ root: '/graphs/other' })

    await expect
      .poll(() => commands().filter((command) => command === 'search_ipc_start'))
      .toHaveLength(2)
    expect(commands().filter((command) => command === 'search_ipc_stop')).toHaveLength(1)

    graphSession.setGraph(null)
    await expect
      .poll(() => commands().filter((command) => command === 'search_ipc_stop'))
      .toHaveLength(2)
    stop()
  })

  it('serves nothing from a note window or on mobile', async () => {
    const noteWindow = await setup({ role: 'note-window' })
    noteWindow.searchIpc.start()
    const mobile = await setup({ mobile: true })
    mobile.searchIpc.start()

    expect(noteWindow.commands()).toEqual([])
    expect(mobile.commands()).toEqual([])
  })

  it('logs a malformed request and answers nothing', async () => {
    const { searchIpc, ipc, logger, commands } = await setup()

    const stop = searchIpc.start()
    await expect.poll(commands).toContain('search_ipc_start')
    ipc.emit('search-ipc:request', { id: 'not a number' })

    expect(logger.getErrors().map((entry) => entry.message)).toEqual([
      'invalid search-ipc:request payload:',
    ])
    expect(commands()).not.toContain('search_ipc_respond')
    stop()
  })

  it('logs, and keeps search in-app, when the socket cannot be served', async () => {
    const { searchIpc, ipc, logger } = await setup()
    ipc.onCommand('search_ipc_start', () => {
      throw new AppError('io', 'path too long for a socket')
    })

    const stop = searchIpc.start()

    await expect
      .poll(() => logger.getWarnings().map((entry) => entry.message))
      .toEqual(['search for the CLI is unavailable:'])
    stop()
  })
})
