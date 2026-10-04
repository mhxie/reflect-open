import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '../../ipc/bridge.ts'
import { loadChatMessages, saveChatMessage } from './store.ts'
import type { AssistantPart, ChatTurn } from './transcript.ts'

/**
 * The store against a scripted bridge: writes assert the exact Rust command
 * payload (the serde contract), reads assert the JSON columns parse back
 * into the same {@link ChatTurn} — and that a corrupt row is dropped, not
 * fatal.
 */

const invoke = vi.fn<(command: string, args: Record<string, unknown>) => Promise<unknown>>()

beforeEach(() => {
  invoke.mockReset()
  setBridge({ invoke, listen: async () => () => {} })
})

afterEach(() => {
  setBridge(null)
  vi.restoreAllMocks()
})

const turn: ChatTurn = {
  id: 'turn-1',
  userText: 'what is this?',
  attachments: [
    {
      id: 'att-1',
      name: 'cat.png',
      mediaType: 'image/png',
      dataUrl: 'data:image/png;base64,iVBORw==',
    },
  ],
  parts: [
    {
      kind: 'tool',
      call: { tool: 'search', toolCallId: 'tool-1', query: 'cat' },
      result: {
        tool: 'search',
        toolCallId: 'tool-1',
        query: 'cat',
        hits: [{ path: 'notes/a.md', title: 'Cats' }],
      },
      error: null,
    },
    { kind: 'text', text: 'A cat, per [[Cats]].' },
    { kind: 'notice', tone: 'info', text: 'Stopped.' },
  ],
  responseMessages: [{ role: 'assistant', content: 'A cat, per [[Cats]].' }],
  status: 'done',
}

const conversation = { id: 'conv-1', title: 'what is this?', createdMs: 1_000, updatedMs: 2_000 }

describe('saveChatMessage', () => {
  it('sends the conversation and the JSON-encoded message row', async () => {
    invoke.mockResolvedValue(null)
    await saveChatMessage({ conversation, turn, createdMs: 2_000, generation: 7 })

    // No `seq` in the payload — Rust assigns it inside the insert.
    expect(invoke).toHaveBeenCalledWith('chat_message_save', {
      conversation,
      message: {
        id: 'turn-1',
        conversationId: 'conv-1',
        userText: 'what is this?',
        attachments: JSON.stringify(turn.attachments),
        parts: JSON.stringify(turn.parts),
        responseMessages: JSON.stringify(turn.responseMessages),
        createdMs: 2_000,
      },
      generation: 7,
    })
  })
})

describe('loadChatMessages', () => {
  function messageRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
    return {
      id: 'turn-1',
      user_text: turn.userText,
      attachments: JSON.stringify(turn.attachments),
      parts: JSON.stringify(turn.parts),
      response_messages: JSON.stringify(turn.responseMessages),
      ...overrides,
    }
  }

  it('round-trips a persisted turn, restored as done', async () => {
    invoke.mockResolvedValue([messageRow()])
    const turns = await loadChatMessages('conv-1')
    expect(turns).toEqual([turn])
    // The query went through the read-only bridge with the conversation bound.
    const [command, args] = invoke.mock.calls[0]!
    expect(command).toBe('db_query')
    expect(args).toMatchObject({ params: ['conv-1'] })
  })

  it('drops an unreadable row but keeps the rest', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    invoke.mockResolvedValue([messageRow({ id: 'turn-bad', parts: '{not json' }), messageRow()])
    const turns = await loadChatMessages('conv-1')
    expect(turns).toEqual([turn])
    expect(error).toHaveBeenCalledOnce()
  })

  it('drops a row whose parts fail validation', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    invoke.mockResolvedValue([messageRow({ parts: JSON.stringify([{ kind: 'mystery' }]) })])
    expect(await loadChatMessages('conv-1')).toEqual([])
  })

  it('saves read_assets calls and results and loads them back intact', async () => {
    const assetsTurn: ChatTurn = {
      ...turn,
      parts: [
        {
          kind: 'tool',
          call: {
            tool: 'assets',
            toolCallId: 'tool-1',
            paths: ['assets/chart.png', 'assets/a.pdf'],
          },
          result: {
            tool: 'assets',
            toolCallId: 'tool-1',
            assets: [
              { path: 'assets/chart.png', error: null },
              { path: 'assets/a.pdf', error: 'This asset cannot be read by AI.' },
            ],
          },
          error: null,
        },
        {
          kind: 'tool',
          call: { tool: 'assets', toolCallId: 'tool-2', paths: ['assets/b.png'] },
          result: null,
          error: 'disk error',
        },
        { kind: 'text', text: 'A bar chart.' },
      ],
    }
    invoke.mockResolvedValue(null)
    await saveChatMessage({ conversation, turn: assetsTurn, createdMs: 2_000, generation: 7 })
    expect(invoke).toHaveBeenCalledWith(
      'chat_message_save',
      expect.objectContaining({
        message: expect.objectContaining({ parts: JSON.stringify(assetsTurn.parts) }),
      }),
    )

    invoke.mockResolvedValue([messageRow({ parts: JSON.stringify(assetsTurn.parts) })])
    expect(await loadChatMessages('conv-1')).toEqual([assetsTurn])
  })

  it('loads a row saved before read_assets existed unchanged', async () => {
    // Rows written before read_assets existed carry only the older tools;
    // widening the schema must not change how they load.
    const olderParts: AssistantPart[] = [
      {
        kind: 'tool',
        call: { tool: 'read', toolCallId: 'tool-1', paths: ['notes/a.md'] },
        result: {
          tool: 'read',
          toolCallId: 'tool-1',
          notes: [{ path: 'notes/a.md', title: 'Cats', error: null }],
        },
        error: null,
      },
      {
        kind: 'tool',
        call: { tool: 'recents', toolCallId: 'tool-2', tag: null },
        result: { tool: 'recents', toolCallId: 'tool-2', tag: null, notes: [], error: null },
        error: null,
      },
      {
        kind: 'tool',
        call: { tool: 'dailies', toolCallId: 'tool-3', start: '2026-06-01', end: '2026-06-02' },
        result: {
          tool: 'dailies',
          toolCallId: 'tool-3',
          start: '2026-06-01',
          end: '2026-06-02',
          days: [{ path: 'daily/2026-06-01.md', title: '2026-06-01' }],
        },
        error: null,
      },
      { kind: 'text', text: 'Cats, per [[Cats]].' },
    ]
    invoke.mockResolvedValue([messageRow({ parts: JSON.stringify(olderParts) })])
    expect(await loadChatMessages('conv-1')).toEqual([{ ...turn, parts: olderParts }])
  })

  it('upgrades a legacy single-note read part to the batch shape', async () => {
    // History persisted before read_notes stored read as a single note; it must
    // still load, rewritten to the current paths/notes shape rather than dropped.
    const legacyParts = [
      {
        kind: 'tool',
        call: { tool: 'read', toolCallId: 'tool-2', path: 'notes/a.md' },
        result: {
          tool: 'read',
          toolCallId: 'tool-2',
          path: 'notes/a.md',
          title: 'Cats',
          error: null,
        },
        error: null,
      },
    ]
    invoke.mockResolvedValue([messageRow({ parts: JSON.stringify(legacyParts) })])
    const [restored] = await loadChatMessages('conv-1')
    expect(restored?.parts).toEqual([
      {
        kind: 'tool',
        call: { tool: 'read', toolCallId: 'tool-2', paths: ['notes/a.md'] },
        result: {
          tool: 'read',
          toolCallId: 'tool-2',
          notes: [{ path: 'notes/a.md', title: 'Cats', error: null }],
        },
        error: null,
      },
    ])
  })
})
