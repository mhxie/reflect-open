import type { ModelMessage } from '@reflect/modules/ai'
import { describe, expect, it, vi } from 'vitest'
import { convertArrayToReadableStream, MockLanguageModelV3 } from '@reflect/modules/ai/test'
import type {
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
  LanguageModelV3Usage,
} from '@ai-sdk/provider'
import type { RetrievalHit } from '../../embeddings/retrieve.ts'
import {
  applyProjection,
  connectIndex,
  openMigratedIndex,
  project,
} from '../../indexing/flow-test-harness.ts'
import { setBridge } from '../../ipc/bridge.ts'
import { cloudSafeGraphContext } from '../../privacy/checkers.ts'
import type { AiProviderConfig } from '../../settings/schema.ts'
import { languageModel } from '../language-model.ts'
import { fitToContextWindow } from './context-window.ts'
import { MAX_STEPS, streamChat, streamChatTurn, type ChatStreamEvent } from './stream-chat.ts'

vi.mock('../language-model', () => ({
  languageModel: vi.fn(),
}))

vi.mock('./context-window', async (importOriginal) => {
  const original = await importOriginal<typeof import('./context-window.ts')>()
  return {
    ...original,
    fitToContextWindow: vi.fn(original.fitToContextWindow),
  }
})

const languageModelMock = vi.mocked(languageModel)
const fitToContextWindowMock = vi.mocked(fitToContextWindow)

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
}

const PRIVATE_HIT: RetrievalHit = {
  path: PRIVATE_PATH,
  title: PRIVATE_TITLE,
  score: 0.9,
  snippet: '',
  heading: null,
  isPrivate: true,
}

describe('streamChat', () => {
  it('does not start a provider request when stopped while the model loads', async () => {
    const controller = new AbortController()
    const loading = Promise.withResolvers<Awaited<ReturnType<typeof languageModel>>>()
    const loadStarted = Promise.withResolvers<void>()
    const model = new MockLanguageModelV3({ doStream: sequence([textTurn('never')]) })
    languageModelMock.mockImplementationOnce(() => {
      loadStarted.resolve()
      return loading.promise
    })
    const events = collect(
      streamChat({
        config: { id: 'cfg', provider: 'openai', model: 'gpt-5.5', keyHint: 'test' },
        apiKey: 'sk-test',
        fetchFn: globalThis.fetch,
        messages: [{ role: 'user', content: 'hello' }],
        today: '2026-09-04',
        semanticSearchEnabled: false,
        customSystemPrompt: '',
        context: null,
        signal: controller.signal,
      }),
    )
    // The history privacy check runs first; stop once the model is loading.
    await loadStarted.promise
    controller.abort()
    loading.resolve(model)

    expect(await events).toEqual([{ type: 'aborted', messages: [] }])
    expect(model.doStreamCalls).toHaveLength(0)
  })

  it('does not load the model when stopped during the history privacy check', async () => {
    const controller = new AbortController()
    const loads = languageModelMock.mock.calls.length
    const events = collect(
      streamChat({
        config: { id: 'cfg', provider: 'openai', model: 'gpt-5.5', keyHint: 'test' },
        apiKey: 'sk-test',
        fetchFn: globalThis.fetch,
        messages: [{ role: 'user', content: 'hello' }],
        today: '2026-09-04',
        semanticSearchEnabled: false,
        customSystemPrompt: '',
        context: null,
        signal: controller.signal,
      }),
    )
    controller.abort()

    expect(await events).toEqual([{ type: 'aborted', messages: [] }])
    expect(languageModelMock.mock.calls.length).toBe(loads)
  })

  it('normalizes a model-loading failure and permits a later turn', async () => {
    const options = {
      config: { id: 'cfg', provider: 'openai' as const, model: 'gpt-5.5', keyHint: 'test' },
      apiKey: 'sk-test',
      fetchFn: globalThis.fetch,
      messages: [{ role: 'user' as const, content: 'hello' }],
      today: '2026-09-04',
      semanticSearchEnabled: false,
      customSystemPrompt: '',
      context: null,
    }
    languageModelMock.mockRejectedValueOnce(new Error('model chunk unavailable'))
    expect(await collect(streamChat(options))).toEqual([
      { type: 'error', message: 'model chunk unavailable', messages: [] },
    ])

    const model = new MockLanguageModelV3({ doStream: sequence([textTurn('loaded')]) })
    languageModelMock.mockResolvedValueOnce(model)
    const events = await collect(streamChat(options))
    expect(events[0]).toEqual({ type: 'text-delta', text: 'loaded' })
    expect(events.at(-1)?.type).toBe('complete')
  })

  it('uses the custom system prompt for context accounting and the provider request', async () => {
    const customSystemPrompt = 'sentinel-custom-system-prompt-01jxq3'
    const messages: ModelMessage[] = [{ role: 'user', content: 'hello' }]
    const model = new MockLanguageModelV3({ doStream: sequence([textTurn('hi')]) })
    languageModelMock.mockResolvedValue(model)

    await collect(
      streamChat({
        config: {
          id: 'cfg-openai',
          provider: 'openai',
          model: 'gpt-5.5',
          keyHint: 'wxyz1',
        },
        apiKey: 'sk-live-key',
        fetchFn: globalThis.fetch,
        messages,
        today: '2026-06-11',
        semanticSearchEnabled: true,
        customSystemPrompt,
        context: null,
      }),
    )

    const fitCall = fitToContextWindowMock.mock.calls.at(-1)
    if (fitCall === undefined) {
      expect.unreachable('expected context-window fitting')
    }
    expect(fitCall[0]).toBe(messages)
    expect(fitCall[1].systemPrompt).toContain(customSystemPrompt)

    expect(model.doStreamCalls).toHaveLength(1)
    expect(JSON.stringify(model.doStreamCalls[0]?.prompt)).toContain(customSystemPrompt)
  })
})

describe('streamChat history privacy', () => {
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
    ...readExchange(PRIVATE_QUESTION, PRIVATE_PATH, PRIVATE_TITLE, PRIVATE_BODY),
    ...readExchange('and atlas?', 'notes/atlas.md', 'Atlas Launch Plan', 'launch plan'),
    { role: 'user', content: 'anything else?' },
  ]

  function turn(config: AiProviderConfig) {
    return streamChat({
      config,
      apiKey: 'sk-test',
      fetchFn: globalThis.fetch,
      messages: HISTORY,
      today: '2026-06-11',
      semanticSearchEnabled: false,
      customSystemPrompt: '',
      context: null,
    })
  }

  it('sends a cloud model no exchange that read a note private now', async () => {
    // The note was public when the first exchange read it; it is locked now.
    const database = openMigratedIndex()
    applyProjection(database, project('notes/atlas.md', '# Atlas Launch Plan\n', 1))
    applyProjection(
      database,
      project(PRIVATE_PATH, `---\nprivate: true\n---\n# ${PRIVATE_TITLE}\n`, 2),
    )
    connectIndex(database)
    const model = new MockLanguageModelV3({ doStream: sequence([textTurn('Nothing else.')]) })
    languageModelMock.mockResolvedValueOnce(model)
    try {
      const events = await collect(
        turn({ id: 'cfg', provider: 'openai', model: 'gpt-5.5', keyHint: 'test' }),
      )

      expect(events[0]).toEqual({ type: 'history-withheld' })
      expect(events.at(-1)?.type).toBe('complete')
      const outbound = JSON.stringify(model.doStreamCalls[0]?.prompt)
      for (const sentinel of [PRIVATE_PATH, PRIVATE_TITLE, PRIVATE_BODY, PRIVATE_QUESTION]) {
        expect(outbound).not.toContain(sentinel)
      }
      expect(outbound).toContain('notes/atlas.md')
      expect(outbound).toContain('anything else?')
    } finally {
      setBridge(null)
      database.close()
    }
  })

  it('sends a model on this Mac the full history', async () => {
    // No bridge installed: asking the index would fail the turn.
    const model = new MockLanguageModelV3({ doStream: sequence([textTurn('Nothing else.')]) })
    languageModelMock.mockResolvedValueOnce(model)
    const baseUrl = 'http://localhost:11434/v1'

    const events = await collect(
      turn({
        id: 'ollama',
        provider: 'openai-compatible',
        model: 'llama3.2',
        baseUrl,
        keyHint: '',
        onDevice: { baseUrl, model: 'llama3.2' },
      }),
    )

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
      streamChatTurn(model, {
        messages: [{ role: 'user', content: 'where is the launch plan?' }],
        today: '2026-06-11',
        semanticSearchEnabled: true,
        customSystemPrompt: '',
        context: null,
        toolDeps: {
          retrieveFn: async () => [PUBLIC_HIT, PRIVATE_HIT],
          readNoteFn: async () => 'launch plan\n',
        },
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
      streamChatTurn(model, {
        messages: [{ role: 'user', content: 'what do my notes say?' }],
        today: '2026-06-11',
        semanticSearchEnabled: true,
        customSystemPrompt: '',
        context: null,
        toolDeps: {
          retrieveFn: async () => [PUBLIC_HIT, PRIVATE_HIT],
          readNoteFn: async () => 'launch plan\n',
        },
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
      streamChatTurn(model, {
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
      streamChatTurn(model, {
        messages: [{ role: 'user', content: 'hi' }],
        today: '2026-06-11',
        semanticSearchEnabled: true,
        customSystemPrompt: '',
        context: null,
      }),
    )
    expect(events.at(-1)).toEqual({ type: 'error', message: 'rate limited', messages: [] })
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
      streamChatTurn(model, {
        messages: [{ role: 'user', content: 'where is the launch plan?' }],
        today: '2026-06-11',
        semanticSearchEnabled: true,
        customSystemPrompt: '',
        context: null,
        toolDeps: { retrieveFn: async () => [PUBLIC_HIT], readNoteFn: async () => 'launch plan\n' },
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
      streamChatTurn(model, {
        messages: [{ role: 'user', content: 'plan and budget?' }],
        today: '2026-06-11',
        semanticSearchEnabled: true,
        customSystemPrompt: '',
        context: null,
        toolDeps: { retrieveFn: async () => [PUBLIC_HIT], readNoteFn: async () => 'launch plan\n' },
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
      streamChatTurn(model, {
        messages: [{ role: 'user', content: 'summarize everything' }],
        today: '2026-06-11',
        semanticSearchEnabled: true,
        customSystemPrompt: '',
        context: null,
        toolDeps: { retrieveFn: async () => [PUBLIC_HIT], readNoteFn: async () => 'body\n' },
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
