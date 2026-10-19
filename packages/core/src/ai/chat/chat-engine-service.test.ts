import { createTestGraphSessionService } from '../../testing/graph-session.ts'
import type { LanguageModel, ModelMessage } from '@reflect/modules/ai'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { convertArrayToReadableStream, MockLanguageModelV3 } from '@reflect/modules/ai/test'
import type {
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
  LanguageModelV3Usage,
} from '@ai-sdk/provider'
import type { RetrievalHit } from '../../embeddings/retrieval-service.ts'
import { createAssetPrivacyService } from '../../assets/asset-privacy-service.ts'
import { ReflectError } from '../../errors.ts'
import { NO_LOCAL_ONLY_FOLDERS } from '../../graph/local-only.ts'
import { project } from '../../indexing/flow-test-harness.ts'
import { createNoteListService } from '../../indexing/note-list-service.ts'
import { cloudTarget, modelTarget, type VerifiedModelTarget } from '../../privacy/on-device.ts'
import { cloudSafeGraphContext, createPrivacyService } from '../../privacy/privacy-service.ts'
import type { AiProviderConfig } from '../../settings/schema.ts'
import {
  createTestAssetStoreService,
  createTestDatabaseService,
  createTestLanguageModelService,
  createTestLoggerService,
  createTestNoteFileService,
  createTestOnDeviceModelService,
  createTestRetrievalService,
  createTestXArchiveService,
  type TestDatabaseService,
  type TestLanguageModelService,
  type TestLoggerService,
  type TestOnDeviceModelService,
} from '../../testing/index.ts'
import type { TargetModel } from '../language-model-service.ts'
import {
  createChatEngineService,
  MAX_STEPS,
  streamChatTurn,
  type ChatEngineService,
  type ChatStreamEvent,
  type ChatTurnRequest,
} from './chat-engine-service.ts'
import { createChatPrivacyService, type ChatPrivacyService } from './chat-privacy-service.ts'
import { fitToContextWindow, type ContextWindowOptions } from './context-window.ts'
import {
  createNoteToolsService,
  type NoteTools,
  type NoteToolsService,
} from './note-tools-service.ts'
import { buildHistory } from './transcript.ts'

let logger: TestLoggerService
let languageModelService: TestLanguageModelService
let onDeviceModels: TestOnDeviceModelService
let fitCalls: [ModelMessage[], ContextWindowOptions][]
let engine: ChatEngineService

beforeEach(() => {
  logger = createTestLoggerService()
  languageModelService = createTestLanguageModelService()
  onDeviceModels = createTestOnDeviceModelService()
  fitCalls = []
  engine = createEngine(graphOver())
})

/**
 * Scripted retrieval and note reads; an empty graph by default.
 */
interface GraphEffects {
  retrieveFn?: () => Promise<RetrievalHit[]>
  readNoteFn?: (path: string) => Promise<string>
}

/**
 * The graph a turn reads from, and the services over it.
 */
interface TestGraph {
  database: TestDatabaseService
  noteTools: NoteToolsService
  chatPrivacy: ChatPrivacyService
}

/**
 * An index holding `notes` (path → Markdown, which also answers the live
 * reads unless `effects.readNoteFn` does), with the note tools and the
 * history gate over it.
 */
function graphOver(
  notes: Readonly<Record<string, string>> = {},
  effects: GraphEffects = {},
): TestGraph {
  const database = createTestDatabaseService()
  for (const [path, source] of Object.entries(notes)) {
    database.applyProjection(project(path, source, 1))
  }
  const noteFile = createTestNoteFileService()
  vi.spyOn(noteFile, 'readShareable').mockImplementation(async (path) => {
    const content = effects.readNoteFn !== undefined ? await effects.readNoteFn(path) : notes[path]
    if (content === undefined) {
      throw new ReflectError('notFound', `${path} not found`)
    }
    return { kind: 'content', content }
  })
  const retrieval = createTestRetrievalService()
  if (effects.retrieveFn !== undefined) {
    vi.spyOn(retrieval, 'retrieve').mockImplementation(effects.retrieveFn)
  }
  const xArchive = createTestXArchiveService()
  const assetReferences = { notePaths: async () => [] }
  const graphSession = createTestGraphSessionService({ graph: { generation: 1 } })
  const assetStore = createTestAssetStoreService()
  const assetPrivacy = createAssetPrivacyService({
    noteFile,
    xArchive,
    assetReferences,
    graphSession,
  })
  const chatPrivacy = createChatPrivacyService({
    database,
    noteFile,
    assetStore,
    assetReferences,
    assetPrivacy,
  })
  const noteTools = createNoteToolsService({
    retrieval,
    noteFile,
    assetStore,
    noteList: createNoteListService({ database }),
    dailyNotes: { listDailyNotes: async () => [] },
    assetReferences,
    assetPrivacy,
    xArchive,
    privacy: createPrivacyService({ noteFile, graphSession }),
    chatPrivacy,
  })
  return { database, noteTools, chatPrivacy }
}

/**
 * The engine over `graph`, with the scripted model and server check.
 */
function createEngine(graph: TestGraph): ChatEngineService {
  return createChatEngineService({
    logger,
    languageModel: languageModelService,
    onDeviceModels,
    noteTools: graph.noteTools,
    chatPrivacy: graph.chatPrivacy,
    fitToContextWindow: (messages, options) => {
      fitCalls.push([messages, options])
      return fitToContextWindow(messages, options)
    },
  })
}

const CLOUD = cloudTarget({ id: 'cfg', provider: 'openai', model: 'gpt-5.5', keyHint: 'test' })

/**
 * The tool set over scripted retrieval and note reads, bound to a cloud model.
 */
function tools(effects?: GraphEffects): NoteTools {
  return graphOver({}, effects).noteTools.build({
    semanticSearchEnabled: true,
    generation: 1,
    localOnly: NO_LOCAL_ONLY_FOLDERS,
    target: CLOUD,
  })
}

/**
 * `model` bound to a cloud target, as `LanguageModelService.createFor` binds it.
 */
async function cloudModel(model: LanguageModel): Promise<TargetModel<VerifiedModelTarget>> {
  return await createTestLanguageModelService(model).createFor(CLOUD, '')
}

const USAGE: LanguageModelV3Usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
}

// Sentinels that cannot collide with prompt copy or fixture prose, so the
// not-in-payload assertions below can never pass vacuously.
const PRIVATE_TITLE = 'sentinel-title-01jxq3'
const PRIVATE_PATH = 'notes/sentinel-path-01jxq3.md'

function stream(parts: LanguageModelV3StreamPart[]): LanguageModelV3StreamResult {
  return {
    stream: convertArrayToReadableStream<LanguageModelV3StreamPart>([
      { type: 'stream-start', warnings: [] },
      { type: 'response-metadata', id: 'res', modelId: 'mock', timestamp: new Date(0) },
      ...parts,
    ]),
  }
}

/**
 * One stream result per doStream call, in order. (The mock's own array form
 * indexes by the post-push call count, skipping element 0 — a function keeps
 * the sequencing explicit instead.)
 */
function sequence(
  results: LanguageModelV3StreamResult[],
): () => Promise<LanguageModelV3StreamResult> {
  let index = 0
  return async () => {
    const next = results[index]
    index += 1
    if (next === undefined) {
      throw new Error(`mock model called ${index} times but only ${results.length} turns staged`)
    }
    return next
  }
}

function toolCallTurn(query: string, toolCallId = 'call-1') {
  return stream([
    {
      type: 'tool-call',
      toolCallId,
      toolName: 'search_notes',
      input: JSON.stringify({ query }),
    },
    { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage: USAGE },
  ])
}

function textTurn(text: string) {
  return stream([
    { type: 'text-start', id: 'text-1' },
    { type: 'text-delta', id: 'text-1', delta: text },
    { type: 'text-end', id: 'text-1' },
    { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: USAGE },
  ])
}

async function collect(events: AsyncGenerator<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const all: ChatStreamEvent[] = []
  for await (const event of events) {
    all.push(event)
  }
  return all
}

const PUBLIC_HIT: RetrievalHit = {
  path: 'notes/atlas.md',
  title: 'Atlas Launch Plan',
  score: 1,
  snippet: 'launch plan',
  heading: null,
  isPrivate: false,
  assetTextHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  hasConflict: false,
}

const PRIVATE_HIT: RetrievalHit = {
  path: PRIVATE_PATH,
  title: PRIVATE_TITLE,
  score: 0.9,
  snippet: '',
  heading: null,
  isPrivate: true,
  hasConflict: false,
}

describe('ChatEngineService.streamTurn', () => {
  it('does not start a provider request when stopped while the model loads', async () => {
    const controller = new AbortController()
    const loading = Promise.withResolvers<LanguageModel>()
    const loadStarted = Promise.withResolvers<void>()
    const model = new MockLanguageModelV3({ doStream: sequence([textTurn('never')]) })
    languageModelService.setModel(() => {
      loadStarted.resolve()
      return loading.promise
    })
    const events = collect(
      engine.streamTurn({
        config: { id: 'cfg', provider: 'openai', model: 'gpt-5.5', keyHint: 'test' },
        apiKey: 'sk-test',
        messages: [{ role: 'user', content: 'hello' }],
        today: '2026-09-04',
        semanticSearchEnabled: false,
        generation: 1,
        localOnly: NO_LOCAL_ONLY_FOLDERS,
        customSystemPrompt: '',
        context: null,
        signal: controller.signal,
      }),
    )
    // The target and history checks run first; stop once the model is loading.
    await loadStarted.promise
    controller.abort()
    loading.resolve(model)

    expect(await events).toEqual([{ type: 'aborted', messages: [] }])
    expect(model.doStreamCalls).toHaveLength(0)
  })

  it('does not load the model when stopped during the privacy checks', async () => {
    const controller = new AbortController()
    const events = collect(
      engine.streamTurn({
        config: { id: 'cfg', provider: 'openai', model: 'gpt-5.5', keyHint: 'test' },
        apiKey: 'sk-test',
        messages: [{ role: 'user', content: 'hello' }],
        today: '2026-09-04',
        semanticSearchEnabled: false,
        generation: 1,
        localOnly: NO_LOCAL_ONLY_FOLDERS,
        customSystemPrompt: '',
        context: null,
        signal: controller.signal,
      }),
    )
    controller.abort()

    expect(await events).toEqual([{ type: 'aborted', messages: [] }])
    expect(languageModelService.calls()).toEqual([])
  })

  it('normalizes a model-loading failure and permits a later turn', async () => {
    const options = {
      config: { id: 'cfg', provider: 'openai' as const, model: 'gpt-5.5', keyHint: 'test' },
      apiKey: 'sk-test',
      messages: [{ role: 'user' as const, content: 'hello' }],
      today: '2026-09-04',
      semanticSearchEnabled: false,
      generation: 1,
      localOnly: NO_LOCAL_ONLY_FOLDERS,
      customSystemPrompt: '',
      context: null,
    }
    languageModelService.setModel(() => Promise.reject(new Error('model chunk unavailable')))
    expect(await collect(engine.streamTurn(options))).toEqual([
      { type: 'error', message: 'model chunk unavailable', messages: [] },
    ])

    const model = new MockLanguageModelV3({ doStream: sequence([textTurn('loaded')]) })
    languageModelService.setModel(model)
    const events = await collect(engine.streamTurn(options))
    expect(events[0]).toEqual({ type: 'text-delta', text: 'loaded' })
    expect(events.at(-1)?.type).toBe('complete')
  })

  it('uses the custom system prompt for context accounting and the provider request', async () => {
    const customSystemPrompt = 'sentinel-custom-system-prompt-01jxq3'
    const messages: ModelMessage[] = [{ role: 'user', content: 'hello' }]
    const model = new MockLanguageModelV3({ doStream: sequence([textTurn('hi')]) })
    languageModelService.setModel(model)

    await collect(
      engine.streamTurn({
        config: {
          id: 'cfg-openai',
          provider: 'openai',
          model: 'gpt-5.5',
          keyHint: 'wxyz1',
        },
        apiKey: 'sk-live-key',
        messages,
        today: '2026-06-11',
        semanticSearchEnabled: true,
        generation: 1,
        localOnly: NO_LOCAL_ONLY_FOLDERS,
        customSystemPrompt,
        context: null,
      }),
    )

    const fitCall = fitCalls.at(-1)
    if (fitCall === undefined) {
      expect.unreachable('expected context-window fitting')
    }
    expect(fitCall[0]).toBe(messages)
    expect(fitCall[1].systemPrompt).toContain(customSystemPrompt)

    expect(model.doStreamCalls).toHaveLength(1)
    expect(JSON.stringify(model.doStreamCalls[0]?.prompt)).toContain(customSystemPrompt)
  })
})

describe('ChatEngineService.streamTurn history privacy', () => {
  const PRIVATE_BODY = 'sentinel-body-01jxq3'
  const PRIVATE_QUESTION = 'sentinel-question-01jxq3'

  /** An earlier exchange that read one note through read_notes. */
  function readExchange(question: string, path: string, title: string, body: string) {
    const toolCallId = `call-${path}`
    const messages: ModelMessage[] = [
      { role: 'user', content: question },
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId, toolName: 'read_notes', input: { paths: [path] } },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId,
            toolName: 'read_notes',
            output: {
              type: 'json',
              value: {
                notes: [{ ok: true, note: { path, title, content: body, truncated: false } }],
              },
            },
          },
        ],
      },
      { role: 'assistant', content: `${title} says ${body}` },
    ]
    return messages
  }

  const HISTORY: ModelMessage[] = [
    ...readExchange('and atlas?', 'notes/atlas.md', 'Atlas Launch Plan', 'launch plan'),
    ...readExchange(PRIVATE_QUESTION, PRIVATE_PATH, PRIVATE_TITLE, PRIVATE_BODY),
    { role: 'user', content: 'anything else?' },
  ]

  const CLOUD_CONFIG: AiProviderConfig = {
    id: 'cfg',
    provider: 'openai',
    model: 'gpt-5.5',
    keyHint: 'test',
  }
  const ON_DEVICE_URL = 'http://localhost:11434/v1'
  const ON_DEVICE_CONFIG: AiProviderConfig = {
    id: 'ollama',
    provider: 'openai-compatible',
    model: 'llama3.2',
    baseUrl: ON_DEVICE_URL,
    keyHint: '',
    onDevice: { baseUrl: ON_DEVICE_URL, model: 'llama3.2' },
  }

  /** An index of Atlas and the sentinel note, which is locked unless `locked` is false. */
  function indexedGraph(locked = true): TestGraph {
    const header = locked ? '---\nprivate: true\n---\n' : ''
    return graphOver({
      'notes/atlas.md': '# Atlas Launch Plan\n',
      [PRIVATE_PATH]: `${header}# ${PRIVATE_TITLE}\n`,
    })
  }

  function turn(
    over: ChatEngineService,
    config: AiProviderConfig,
    messages: ModelMessage[] = HISTORY,
  ): AsyncGenerator<ChatStreamEvent> {
    const request: ChatTurnRequest = {
      config,
      apiKey: 'sk-test',
      messages,
      today: '2026-06-11',
      semanticSearchEnabled: false,
      generation: 1,
      localOnly: NO_LOCAL_ONLY_FOLDERS,
      customSystemPrompt: '',
      context: null,
    }
    return over.streamTurn(request)
  }

  /** The provider the next turn loads, answering with one text reply. */
  function nextModel(): MockLanguageModelV3 {
    const model = new MockLanguageModelV3({ doStream: sequence([textTurn('Nothing else.')]) })
    languageModelService.setModel(model)
    return model
  }

  /** Expect the prompt `model` received to name neither the sentinel note nor the turn that read it. */
  function expectNoSentinels(model: MockLanguageModelV3): void {
    const outbound = JSON.stringify(model.doStreamCalls[0]?.prompt)
    for (const sentinel of [PRIVATE_PATH, PRIVATE_TITLE, PRIVATE_BODY, PRIVATE_QUESTION]) {
      expect(outbound).not.toContain(sentinel)
    }
  }

  /**
   * The history a real turn leaves behind: the SDK runs read_notes on the
   * sentinel note while it is public and records the exchange, which then
   * goes through the history's JSON column and `buildHistory` like a
   * restored chat.
   */
  async function recordedHistory(): Promise<ModelMessage[]> {
    const reader = new MockLanguageModelV3({
      doStream: sequence([
        stream([
          {
            type: 'tool-call',
            toolCallId: 'call-read',
            toolName: 'read_notes',
            input: JSON.stringify({ paths: [PRIVATE_PATH] }),
          },
          { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage: USAGE },
        ]),
        textTurn(`It says ${PRIVATE_BODY}`),
      ]),
    })
    const events = await collect(
      streamChatTurn({ logger }, await cloudModel(reader), {
        messages: [{ role: 'user', content: PRIVATE_QUESTION }],
        today: '2026-06-11',
        semanticSearchEnabled: false,
        customSystemPrompt: '',
        context: null,
        tools: tools({ readNoteFn: async () => `# ${PRIVATE_TITLE}\n\n${PRIVATE_BODY}\n` }),
      }),
    )
    const complete = events.at(-1)
    if (complete?.type !== 'complete') {
      throw new Error(`the recorded turn ended with ${String(complete?.type)}`)
    }
    // chat_messages keeps a turn's messages as JSON text.
    const stored = JSON.stringify(complete.messages)
    const responseMessages: ModelMessage[] = JSON.parse(stored)
    return [
      ...buildHistory([
        {
          id: 'turn-1',
          userText: PRIVATE_QUESTION,
          attachments: [],
          parts: [],
          responseMessages,
          status: 'done',
        },
      ]),
      { role: 'user', content: 'anything else?' },
    ]
  }

  it('sends a cloud model no exchange that read a note private now', async () => {
    // The note was public when the first exchange read it; it is locked now.
    const over = createEngine(indexedGraph())
    const model = nextModel()

    const events = await collect(turn(over, CLOUD_CONFIG))

    expect(events[0]).toEqual({ type: 'history-withheld' })
    expect(events.at(-1)?.type).toBe('complete')
    expectNoSentinels(model)
    const outbound = JSON.stringify(model.doStreamCalls[0]?.prompt)
    expect(outbound).toContain('notes/atlas.md')
    expect(outbound).toContain('anything else?')
  })

  it('sends a model on this Mac the full history once its server checks out', async () => {
    const graph = indexedGraph()
    const over = createEngine(graph)
    const queriesBefore = graph.database.getQueries().length
    const model = nextModel()

    const events = await collect(turn(over, ON_DEVICE_CONFIG))

    expect(events.map((event) => event.type)).toEqual(['text-delta', 'complete'])
    expect(onDeviceModels.verifyCalls()).toEqual([
      { target: modelTarget(ON_DEVICE_CONFIG), apiKey: 'sk-test' },
    ])
    // Nothing is withheld from it, so the index is never asked.
    expect(graph.database.getQueries()).toHaveLength(queriesBefore)
    const outbound = JSON.stringify(model.doStreamCalls[0]?.prompt)
    expect(outbound).toContain(PRIVATE_BODY)
    expect(outbound).toContain(PRIVATE_QUESTION)
  })

  it('refuses the turn when an on-device server cannot be verified', async () => {
    const over = createEngine(indexedGraph())
    onDeviceModels.setVerdict({ kind: 'refused', reason: 'This model runs in Ollama’s cloud.' })
    const model = nextModel()

    const events = await collect(turn(over, ON_DEVICE_CONFIG))

    expect(events).toEqual([
      { type: 'error', message: 'This model runs in Ollama’s cloud.', messages: [] },
    ])
    expect(languageModelService.calls()).toEqual([])
    expect(model.doStreamCalls).toHaveLength(0)
  })

  it('fails a cloud turn before loading the model when the index cannot be read', async () => {
    const graph = indexedGraph()
    const over = createEngine(graph)
    graph.database.close()

    const events = await collect(turn(over, CLOUD_CONFIG))

    expect(events).toEqual([{ type: 'error', message: expect.any(String), messages: [] }])
    expect(languageModelService.calls()).toEqual([])
  })

  it('withholds an exchange the SDK recorded once its note is locked', async () => {
    const history = await recordedHistory()
    const over = createEngine(indexedGraph())
    const model = nextModel()

    const events = await collect(turn(over, CLOUD_CONFIG, history))

    expect(events[0]).toEqual({ type: 'history-withheld' })
    expectNoSentinels(model)
  })

  it('resends an exchange the SDK recorded while its note is public', async () => {
    const history = await recordedHistory()
    const over = createEngine(indexedGraph(false))
    const model = nextModel()

    const events = await collect(turn(over, CLOUD_CONFIG, history))

    expect(events.map((event) => event.type)).toEqual(['text-delta', 'complete'])
    const outbound = JSON.stringify(model.doStreamCalls[0]?.prompt)
    expect(outbound).toContain(PRIVATE_BODY)
    expect(outbound).toContain(PRIVATE_QUESTION)
  })
})

describe('streamChatTurn', () => {
  it('streams tool activity, text, and a terminal complete event', async () => {
    const model = new MockLanguageModelV3({
      doStream: sequence([toolCallTurn('atlas'), textTurn('Found it: [[Atlas Launch Plan]]')]),
    })
    const events = await collect(
      streamChatTurn({ logger }, await cloudModel(model), {
        messages: [{ role: 'user', content: 'where is the launch plan?' }],
        today: '2026-06-11',
        semanticSearchEnabled: true,
        customSystemPrompt: '',
        context: null,
        tools: tools({
          retrieveFn: async () => [PUBLIC_HIT, PRIVATE_HIT],
          readNoteFn: async () => 'launch plan\n',
        }),
      }),
    )

    expect(events.map((event) => event.type)).toEqual([
      'tool-call',
      'tool-result',
      'text-delta',
      'complete',
    ])
    expect(events[0]).toEqual({
      type: 'tool-call',
      call: { tool: 'search', toolCallId: 'call-1', query: 'atlas' },
    })
    // The private hit is dropped before it ever reaches an event or payload.
    expect(events[1]).toEqual({
      type: 'tool-result',
      result: {
        tool: 'search',
        toolCallId: 'call-1',
        query: 'atlas',
        hits: [{ path: 'notes/atlas.md', title: 'Atlas Launch Plan' }],
      },
    })
    expect(events[2]).toMatchObject({ text: 'Found it: [[Atlas Launch Plan]]' })
    const complete = events.at(-1)
    expect(complete?.type === 'complete' && complete.messages.length > 0).toBe(true)
  })

  it('never sends private content in the outbound prompt (payload assertion)', async () => {
    const model = new MockLanguageModelV3({
      doStream: sequence([toolCallTurn('diary'), textTurn('done')]),
    })
    await collect(
      streamChatTurn({ logger }, await cloudModel(model), {
        messages: [{ role: 'user', content: 'what do my notes say?' }],
        today: '2026-06-11',
        semanticSearchEnabled: true,
        customSystemPrompt: '',
        context: null,
        tools: tools({
          retrieveFn: async () => [PUBLIC_HIT, PRIVATE_HIT],
          readNoteFn: async () => 'launch plan\n',
        }),
      }),
    )

    // Every prompt that left for the "provider", including the second step
    // carrying the tool result, must be free of the private note.
    expect(model.doStreamCalls.length).toBe(2)
    const outbound = JSON.stringify(model.doStreamCalls.map((call) => call.prompt))
    expect(outbound).not.toContain(PRIVATE_TITLE)
    expect(outbound).not.toContain(PRIVATE_PATH)
    expect(outbound).toContain('notes/atlas.md')
  })

  it('carries the graph overview in the outbound system prompt', async () => {
    const model = new MockLanguageModelV3({ doStream: sequence([textTurn('hi')]) })
    await collect(
      streamChatTurn({ logger }, await cloudModel(model), {
        messages: [{ role: 'user', content: 'hi' }],
        today: '2026-06-11',
        semanticSearchEnabled: true,
        customSystemPrompt: 'Challenge my assumptions before answering.',
        context: cloudSafeGraphContext({
          graphName: 'atlas-graph',
          noteCount: 7,
          dailyNoteCount: 2,
          earliestDailyDate: '2026-06-01',
          latestDailyDate: '2026-06-10',
          tags: [{ tag: 'book', count: 2 }],
          tagsTruncated: false,
        }),
        tools: tools(),
      }),
    )

    const outbound = JSON.stringify(model.doStreamCalls[0]?.prompt)
    expect(outbound).toContain('atlas-graph')
    expect(outbound).toContain('#book (2)')
    expect(outbound).toContain('Daily notes span 2026-06-01 to 2026-06-10.')
    expect(outbound).toContain('Challenge my assumptions before answering.')
  })

  it('yields a terminal error event when the stream errors', async () => {
    const model = new MockLanguageModelV3({
      doStream: sequence([
        stream([
          { type: 'error', error: new Error('rate limited') },
          { type: 'finish', finishReason: { unified: 'error', raw: undefined }, usage: USAGE },
        ]),
      ]),
    })
    const events = await collect(
      streamChatTurn({ logger }, await cloudModel(model), {
        messages: [{ role: 'user', content: 'hi' }],
        today: '2026-06-11',
        semanticSearchEnabled: true,
        customSystemPrompt: '',
        context: null,
        tools: tools(),
      }),
    )
    expect(events.at(-1)).toEqual({ type: 'error', message: 'rate limited', messages: [] })
    expect(logger.getErrors()).toEqual([
      { message: 'chat stream failed:', cause: new Error('rate limited') },
    ])
  })

  it('a cut-short turn still carries the completed steps, properly paired', async () => {
    // Step 1 completes (tool call + result); step 2 streams text, then errors.
    const model = new MockLanguageModelV3({
      doStream: sequence([
        toolCallTurn('atlas'),
        stream([
          { type: 'text-start', id: 'text-1' },
          { type: 'text-delta', id: 'text-1', delta: 'So far' },
          { type: 'error', error: new Error('connection lost') },
          { type: 'finish', finishReason: { unified: 'error', raw: undefined }, usage: USAGE },
        ]),
      ]),
    })
    const events = await collect(
      streamChatTurn({ logger }, await cloudModel(model), {
        messages: [{ role: 'user', content: 'where is the launch plan?' }],
        today: '2026-06-11',
        semanticSearchEnabled: true,
        customSystemPrompt: '',
        context: null,
        tools: tools({
          retrieveFn: async () => [PUBLIC_HIT],
          readNoteFn: async () => 'launch plan\n',
        }),
      }),
    )

    const last = events.at(-1)
    if (last?.type !== 'error') {
      expect.unreachable('expected a terminal error event')
    }
    // The completed step's assistant (tool call) + tool (result) pair survives,
    // plus the interrupted step's partial text — never a dangling tool call.
    expect(last.messages.map((message) => message.role)).toEqual(['assistant', 'tool', 'assistant'])
    expect(JSON.stringify(last.messages.at(-1))).toContain('So far')
    expect(logger.getErrors()).toEqual([
      { message: 'chat stream failed:', cause: new Error('connection lost') },
    ])
  })

  it('keeps every completed step when cut short after multiple tool rounds', async () => {
    // Pins the SDK semantic the engine relies on: each onStepEnd's
    // `response.messages` holds *only that step's* messages, so appending
    // (not assigning) yields the full paired history. If an `ai` upgrade ever
    // makes it cumulative again, this starts failing instead of silently
    // duplicating earlier rounds.
    const model = new MockLanguageModelV3({
      doStream: sequence([
        toolCallTurn('atlas', 'call-1'),
        toolCallTurn('budget', 'call-2'),
        stream([
          { type: 'text-start', id: 'text-1' },
          { type: 'text-delta', id: 'text-1', delta: 'So far' },
          { type: 'error', error: new Error('connection lost') },
          { type: 'finish', finishReason: { unified: 'error', raw: undefined }, usage: USAGE },
        ]),
      ]),
    })
    const events = await collect(
      streamChatTurn({ logger }, await cloudModel(model), {
        messages: [{ role: 'user', content: 'plan and budget?' }],
        today: '2026-06-11',
        semanticSearchEnabled: true,
        customSystemPrompt: '',
        context: null,
        tools: tools({
          retrieveFn: async () => [PUBLIC_HIT],
          readNoteFn: async () => 'launch plan\n',
        }),
      }),
    )

    const last = events.at(-1)
    if (last?.type !== 'error') {
      expect.unreachable('expected a terminal error event')
    }
    expect(last.messages.map((message) => message.role)).toEqual([
      'assistant',
      'tool',
      'assistant',
      'tool',
      'assistant',
    ])
    const outbound = JSON.stringify(last.messages)
    expect(outbound).toContain('call-1')
    expect(outbound).toContain('call-2')
  })

  it('disables tools on the final step so a tool-bound turn still answers', async () => {
    // Every gathering step calls a tool; the model only writes its answer
    // once tools are disabled on the last permitted step. Without that force,
    // the turn would end on a tool result with no reply.
    const gathering = Array.from({ length: MAX_STEPS - 1 }, (_unused, index) =>
      toolCallTurn(`query-${index}`, `call-${index}`),
    )
    const model = new MockLanguageModelV3({
      doStream: sequence([...gathering, textTurn('Summary: [[Atlas Launch Plan]]')]),
    })
    const events = await collect(
      streamChatTurn({ logger }, await cloudModel(model), {
        messages: [{ role: 'user', content: 'summarize everything' }],
        today: '2026-06-11',
        semanticSearchEnabled: true,
        customSystemPrompt: '',
        context: null,
        tools: tools({ retrieveFn: async () => [PUBLIC_HIT], readNoteFn: async () => 'body\n' }),
      }),
    )

    // Every step ran, gathering steps kept tools on, and the final step was
    // forced to answer rather than call another tool.
    expect(model.doStreamCalls.length).toBe(MAX_STEPS)
    expect(model.doStreamCalls[0]?.toolChoice).toEqual({ type: 'auto' })
    expect(model.doStreamCalls.at(-1)?.toolChoice).toEqual({ type: 'none' })
    expect(events.at(-1)?.type).toBe('complete')
    expect(events.some((event) => event.type === 'text-delta')).toBe(true)
  })
})
