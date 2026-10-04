import type { ModelMessage } from '@reflect/modules/ai'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setLocalOnlyFolders } from '../../graph/local-only.ts'
import {
  applyProjection,
  connectIndex,
  openMigratedIndex,
  project,
} from '../../indexing/flow-test-harness.ts'
import { getBridge, setBridge } from '../../ipc/bridge.ts'
import { modelTarget, verifyOnDeviceServer } from '../../privacy/on-device.ts'
import { historyForTarget } from './history-privacy.ts'

/**
 * The resend gate over a real index: notes are projected from Markdown into
 * the production schema, and the gate reads them back through `db_query`,
 * which is counted. The on-device server check keeps its real answer unless
 * a test overrides it.
 */

vi.mock('../../privacy/on-device', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../privacy/on-device.ts')>()
  return {
    ...original,
    verifyOnDeviceServer: vi.fn(original.verifyOnDeviceServer),
  }
})

const verifyOnDeviceServerMock = vi.mocked(verifyOnDeviceServer)

type ToolMessage = Extract<ModelMessage, { role: 'tool' }>
type ToolResultOutput = Extract<ToolMessage['content'][number], { type: 'tool-result' }>['output']
type JsonValue = Extract<ToolResultOutput, { type: 'json' }>['value']

const CLOUD = modelTarget({ id: 'openai', provider: 'openai', model: 'gpt-5.5', keyHint: 'wxyz1' })
const ON_DEVICE = modelTarget({
  id: 'ollama',
  provider: 'openai-compatible',
  model: 'llama3.2',
  baseUrl: 'http://localhost:11434/v1',
  keyHint: '',
  onDevice: { baseUrl: 'http://localhost:11434/v1', model: 'llama3.2' },
})

const PUBLIC = '# Atlas\n'
const LOCKED = '---\nprivate: true\n---\n# Diary\n'

let database: DatabaseSync | null = null
const queries: string[] = []

/** A migrated index holding `notes` (path → Markdown) and asset references. */
function openIndex(
  notes: Record<string, string>,
  assets: readonly (readonly [notePath: string, assetPath: string])[] = [],
): void {
  const index = openMigratedIndex()
  database = index
  for (const [path, source] of Object.entries(notes)) {
    applyProjection(index, project(path, source, 1))
  }
  const insertAsset = index.prepare('INSERT INTO assets(note_path, asset_path) VALUES (?, ?)')
  for (const [notePath, assetPath] of assets) {
    insertAsset.run(notePath, assetPath)
  }
  connectIndex(index)
  const bridge = getBridge()
  setBridge({
    ...bridge,
    invoke: (command, args) => {
      if (command === 'db_query') {
        queries.push(String(args['sql']))
      }
      return bridge.invoke(command, args)
    },
  })
}

afterEach(() => {
  setBridge(null)
  database?.close()
  database = null
  queries.length = 0
  setLocalOnlyFolders([])
  verifyOnDeviceServerMock.mockReset()
})

function user(text: string): ModelMessage {
  return { role: 'user', content: text }
}

/** One earlier exchange: a question, one tool round trip, and the answer. */
function exchange(
  question: string,
  toolName: string,
  output: ToolResultOutput,
  answer: string,
): ModelMessage[] {
  const toolCallId = `call-${question}`
  return [
    user(question),
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId, toolName, input: {} }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId, toolName, output }] },
    { role: 'assistant', content: answer },
  ]
}

function json(value: JsonValue): ToolResultOutput {
  return { type: 'json', value }
}

/** The sentinel body a read of `path` returned. */
function bodyOf(path: string): string {
  return `body-sentinel ${path}`
}

function readNotes(...paths: string[]): ToolResultOutput {
  return json({
    notes: paths.map((path) => ({
      ok: true,
      note: { path, title: path, content: bodyOf(path), truncated: false },
    })),
  })
}

function readAssets(...paths: string[]): ToolResultOutput {
  return json({
    assets: paths.map((path) => ({
      ok: true,
      asset: { path, description: `description of ${path}`, truncated: false },
    })),
  })
}

function listing(path: string): JsonValue {
  return {
    path,
    title: path,
    dailyDate: null,
    snippet: bodyOf(path),
    modifiedAt: '2026-06-01T00:00:00.000Z',
  }
}

describe('historyForTarget', () => {
  it('leaves out the whole exchange that read a note made private since', async () => {
    openIndex({ 'notes/atlas.md': PUBLIC, 'notes/x.md': LOCKED })
    const history: ModelMessage[] = [
      ...exchange('what does x say?', 'read_notes', readNotes('notes/x.md'), 'x says answer-1'),
      ...exchange('and atlas?', 'read_notes', readNotes('notes/atlas.md'), 'Atlas ships.'),
      user('thanks'),
    ]

    const result = await historyForTarget(history, CLOUD)

    expect(result.withheldTurns).toBe(1)
    expect(result.messages).toEqual(history.slice(4))
    const sent = JSON.stringify(result.messages)
    expect(sent).not.toContain('notes/x.md')
    expect(sent).not.toContain('what does x say?')
    expect(sent).not.toContain('answer-1')
  })

  it('leaves out an exchange that read a note in a folder made local-only', async () => {
    // Indexed while still public: the folder rule alone makes it private.
    openIndex({ 'journal/x.md': PUBLIC })
    setLocalOnlyFolders(['journal'])
    const history: ModelMessage[] = [
      ...exchange('x?', 'read_notes', readNotes('journal/x.md'), 'x.'),
      user('next'),
    ]

    expect(await historyForTarget(history, CLOUD)).toEqual({
      messages: [user('next')],
      withheldTurns: 1,
    })
    // A local-only path needs no index row to count as private.
    expect(queries).toHaveLength(0)
  })

  it('counts a note with no index row as private', async () => {
    openIndex({ 'notes/atlas.md': PUBLIC })
    const history: ModelMessage[] = [
      ...exchange('moved?', 'read_notes', readNotes('notes/moved.md'), 'Moved.'),
      user('next'),
    ]

    expect((await historyForTarget(history, CLOUD)).withheldTurns).toBe(1)
  })

  it('keeps exchanges whose searches and listings named only public notes', async () => {
    openIndex({ 'notes/atlas.md': PUBLIC, 'daily/2026-06-01.md': '# June\n' })
    const history: ModelMessage[] = [
      ...exchange(
        'find atlas',
        'search_notes',
        json({ hits: [{ path: 'notes/atlas.md', title: 'Atlas', snippet: 'launch' }] }),
        'Found [[Atlas]].',
      ),
      ...exchange(
        'recent?',
        'list_recent_notes',
        json({ ok: true, notes: [listing('notes/atlas.md')] }),
        'Atlas.',
      ),
      ...exchange(
        'june?',
        'list_daily_notes',
        json({ days: [listing('daily/2026-06-01.md')], truncated: false }),
        'June 1.',
      ),
      user('thanks'),
    ]

    const result = await historyForTarget(history, CLOUD)

    expect(result).toEqual({ messages: history, withheldTurns: 0 })
    // Nothing left out: the turn sends the very array it was given.
    expect(result.messages).toBe(history)
  })

  it('leaves out searches and listings that named a note private now', async () => {
    openIndex({ 'notes/atlas.md': PUBLIC, 'notes/x.md': LOCKED })
    const history: ModelMessage[] = [
      ...exchange(
        'search',
        'search_notes',
        json({ hits: [{ path: 'notes/x.md', title: 'Diary', snippet: 'secret' }] }),
        'Found it.',
      ),
      ...exchange(
        'recent',
        'list_recent_notes',
        json({ ok: true, notes: [listing('notes/atlas.md'), listing('notes/x.md')] }),
        'Two notes.',
      ),
      ...exchange('dailies', 'list_daily_notes', json({ days: [], truncated: false }), 'None.'),
      user('next'),
    ]

    const result = await historyForTarget(history, CLOUD)

    expect(result.withheldTurns).toBe(2)
    expect(result.messages.filter((message) => message.role === 'user')).toEqual([
      user('dailies'),
      user('next'),
    ])
  })

  it('keeps the roles alternating around the exchanges it leaves out', async () => {
    openIndex({ 'notes/atlas.md': PUBLIC, 'notes/x.md': LOCKED })
    const history: ModelMessage[] = [
      ...exchange('one', 'read_notes', readNotes('notes/atlas.md'), 'One.'),
      ...exchange('two', 'read_notes', readNotes('notes/x.md'), 'Two.'),
      ...exchange('three', 'read_notes', readNotes('notes/atlas.md', 'notes/x.md'), 'Three.'),
      user('four'),
      { role: 'assistant', content: 'Four.' },
      user('five'),
    ]

    const { messages } = await historyForTarget(history, CLOUD)

    expect(messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
      'user',
      'assistant',
      'user',
    ])
    expect(messages.filter((message) => message.role === 'user')).toEqual([
      user('one'),
      user('four'),
      user('five'),
    ])
  })

  it('sends an on-device model the full history without asking the index', async () => {
    openIndex({ 'notes/x.md': LOCKED })
    const history: ModelMessage[] = [
      ...exchange('x?', 'read_notes', readNotes('notes/x.md'), 'x.'),
      user('next'),
    ]

    const result = await historyForTarget(history, ON_DEVICE)

    expect(result.withheldTurns).toBe(0)
    expect(result.messages).toBe(history)
    expect(queries).toHaveLength(0)
    expect(verifyOnDeviceServerMock).toHaveBeenCalledExactlyOnceWith(ON_DEVICE)
  })

  it('filters the history like a cloud model when the on-device server is refused', async () => {
    openIndex({ 'notes/atlas.md': PUBLIC, 'notes/x.md': LOCKED })
    verifyOnDeviceServerMock.mockResolvedValueOnce({
      kind: 'refused',
      reason: 'This model runs in Ollama’s cloud.',
    })
    const history: ModelMessage[] = [
      ...exchange('x?', 'read_notes', readNotes('notes/x.md'), 'x.'),
      ...exchange('atlas?', 'read_notes', readNotes('notes/atlas.md'), 'Atlas.'),
      user('next'),
    ]

    expect(await historyForTarget(history, ON_DEVICE)).toEqual({
      messages: history.slice(4),
      withheldTurns: 1,
    })
    expect(queries).toHaveLength(1)
  })

  it('checks every named note and asset in one index query', async () => {
    openIndex({ 'notes/a.md': PUBLIC, 'notes/b.md': PUBLIC, 'notes/c.md': PUBLIC }, [
      ['notes/c.md', 'assets/chart.png'],
    ])
    const history: ModelMessage[] = [
      ...exchange('a', 'read_notes', readNotes('notes/a.md', 'notes/b.md'), 'A.'),
      ...exchange(
        'b',
        'search_notes',
        json({
          hits: [
            { path: 'notes/b.md', title: 'B' },
            { path: 'notes/c.md', title: 'C' },
          ],
        }),
        'B.',
      ),
      ...exchange('c', 'read_assets', readAssets('assets/chart.png'), 'C.'),
      user('next'),
    ]

    expect((await historyForTarget(history, CLOUD)).withheldTurns).toBe(0)
    expect(queries).toHaveLength(1)
  })

  it('asks the index nothing when no earlier exchange read anything', async () => {
    openIndex({})
    const history: ModelMessage[] = [
      user('hi'),
      { role: 'assistant', content: 'Hello.' },
      user('next'),
    ]

    expect((await historyForTarget(history, CLOUD)).messages).toBe(history)
    expect(queries).toHaveLength(0)
  })

  it('ignores refused reads and tool errors, which hold nothing read from a note', async () => {
    openIndex({ 'notes/atlas.md': PUBLIC })
    const history: ModelMessage[] = [
      ...exchange(
        'guess',
        'read_notes',
        json({
          notes: [
            { ok: false, path: 'notes/made-up.md', error: 'No note exists at this path.' },
            {
              ok: true,
              note: { path: 'notes/atlas.md', title: 'Atlas', content: 'x', truncated: false },
            },
          ],
        }),
        'Only Atlas exists.',
      ),
      ...exchange('broken', 'read_notes', { type: 'error-text', value: 'disk error' }, 'Sorry.'),
      user('next'),
    ]

    expect((await historyForTarget(history, CLOUD)).withheldTurns).toBe(0)
  })

  it('reads the result shapes older builds persisted', async () => {
    openIndex({ 'notes/atlas.md': PUBLIC, 'notes/x.md': LOCKED })
    const history: ModelMessage[] = [
      ...exchange(
        'legacy read',
        'read_note',
        json({ ok: true, note: { path: 'notes/x.md', title: 'Diary', content: 'x' } }),
        'Diary.',
      ),
      ...exchange(
        'legacy recents',
        'list_recent_notes',
        json({ notes: [listing('notes/atlas.md')] }),
        'Atlas.',
      ),
      user('next'),
    ]

    const result = await historyForTarget(history, CLOUD)

    expect(result.withheldTurns).toBe(1)
    expect(result.messages[0]).toEqual(user('legacy recents'))
  })
})

describe('historyForTarget over asset reads', () => {
  it('leaves out an asset read once a note embedding it is private', async () => {
    openIndex({ 'notes/public.md': PUBLIC, 'notes/x.md': LOCKED }, [
      ['notes/public.md', 'assets/scan.png'],
      ['notes/x.md', 'assets/scan.png'],
    ])
    const history: ModelMessage[] = [
      ...exchange('scan?', 'read_assets', readAssets('assets/scan.png'), 'A scan.'),
      user('next'),
    ]

    expect((await historyForTarget(history, CLOUD)).withheldTurns).toBe(1)
  })

  it('matches a note that embeds the asset by bare filename', async () => {
    openIndex({ 'notes/public.md': PUBLIC, 'notes/x.md': LOCKED }, [
      ['notes/public.md', 'assets/scan.png'],
      ['notes/x.md', 'scan.png'],
    ])
    const history: ModelMessage[] = [
      ...exchange('scan?', 'read_assets', readAssets('assets/scan.png'), 'A scan.'),
      user('next'),
    ]

    expect((await historyForTarget(history, CLOUD)).withheldTurns).toBe(1)
  })

  it('keeps an asset read while every note embedding it is public', async () => {
    openIndex({ 'notes/a.md': PUBLIC, 'notes/b.md': PUBLIC }, [
      ['notes/a.md', 'assets/scan.png'],
      ['notes/b.md', 'scan.png'],
    ])
    const history: ModelMessage[] = [
      ...exchange('scan?', 'read_assets', readAssets('assets/scan.png'), 'A scan.'),
      user('next'),
    ]

    expect((await historyForTarget(history, CLOUD)).withheldTurns).toBe(0)
  })

  it('counts an asset no indexed note embeds as private', async () => {
    openIndex({ 'notes/a.md': PUBLIC })
    const history: ModelMessage[] = [
      ...exchange('scan?', 'read_assets', readAssets('assets/orphan.png'), 'A scan.'),
      user('next'),
    ]

    expect((await historyForTarget(history, CLOUD)).withheldTurns).toBe(1)
  })

  it('counts an asset embedded from a folder made local-only as private', async () => {
    openIndex({ 'journal/n.md': PUBLIC }, [['journal/n.md', 'assets/scan.png']])
    setLocalOnlyFolders(['journal'])
    const history: ModelMessage[] = [
      ...exchange('scan?', 'read_assets', readAssets('assets/scan.png'), 'A scan.'),
      user('next'),
    ]

    expect((await historyForTarget(history, CLOUD)).withheldTurns).toBe(1)
  })

  it('leaves out an X media read once a note linking the post that owns it is locked', async () => {
    // A public note embeds the media directly; the locked note links the X
    // post, which the index records as the post's archive file.
    openIndex({ 'notes/public.md': PUBLIC, 'notes/x.md': LOCKED }, [
      ['notes/public.md', 'assets/x/abc.jpg'],
      ['notes/x.md', 'assets/x/post-1.json'],
    ])
    const history: ModelMessage[] = [
      ...exchange('photo?', 'read_assets', readAssets('assets/x/abc.jpg'), 'A photo.'),
      user('next'),
    ]

    expect((await historyForTarget(history, CLOUD)).withheldTurns).toBe(1)
  })

  it('counts every X media file as private, since the index does not know its owners', async () => {
    openIndex({ 'notes/public.md': PUBLIC, 'notes/post.md': PUBLIC }, [
      ['notes/public.md', 'assets/x/abc.jpg'],
      ['notes/post.md', 'assets/x/post-1.json'],
    ])
    const history: ModelMessage[] = [
      ...exchange('photo?', 'read_assets', readAssets('assets/x/abc.jpg'), 'A photo.'),
      user('next'),
    ]

    expect((await historyForTarget(history, CLOUD)).withheldTurns).toBe(1)
    expect(queries).toHaveLength(0)
  })
})

describe('historyForTarget fails closed', () => {
  it('leaves out an exchange whose tool it does not know', async () => {
    openIndex({ 'notes/atlas.md': PUBLIC })
    const history: ModelMessage[] = [
      ...exchange('mystery', 'summarize_notes', json({ notes: [] }), 'Done.'),
      user('next'),
    ]

    expect((await historyForTarget(history, CLOUD)).withheldTurns).toBe(1)
  })

  it('leaves out an exchange whose tool output does not parse', async () => {
    openIndex({ 'notes/atlas.md': PUBLIC })
    const history: ModelMessage[] = [
      ...exchange('bad', 'read_notes', json({ notes: 'notes/atlas.md' }), 'Atlas.'),
      ...exchange('text', 'read_notes', { type: 'text', value: 'notes/atlas.md' }, 'Atlas.'),
      user('next'),
    ]

    expect((await historyForTarget(history, CLOUD)).withheldTurns).toBe(2)
  })

  it('leaves out an exchange whose stored tool message is malformed', async () => {
    openIndex({ 'notes/atlas.md': PUBLIC })
    // Stored rows are validated by envelope only, so content can be anything.
    const malformed: ModelMessage = JSON.parse('{"role":"tool","content":{"path":"notes/x.md"}}')
    const history: ModelMessage[] = [user('corrupt'), malformed, user('next')]

    expect(await historyForTarget(history, CLOUD)).toEqual({
      messages: [user('next')],
      withheldTurns: 1,
    })
  })
})
