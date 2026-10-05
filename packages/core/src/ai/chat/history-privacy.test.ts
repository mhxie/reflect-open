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
import { modelTarget, verifyModelTarget, verifyOnDeviceServer } from '../../privacy/on-device.ts'
import { historyForTarget } from './history-privacy.ts'
import { hashContent } from '../../indexing/hash.ts'

/**
 * The resend gate over a real index: notes are projected from Markdown into
 * the production schema, and the gate reads them back through `db_query`,
 * which is counted. The on-device server check keeps its real answer unless
 * a test overrides it.
 */

vi.mock('../../privacy/on-device-verification', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../privacy/on-device-verification.ts')>()
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
      if (command === 'note_read_shareable') {
        const path = String(args['path'])
        return notes[path] === undefined
          ? Promise.reject({ kind: 'notFound', message: 'No sidecar' })
          : Promise.resolve({ kind: 'content', content: notes[path] })
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
  it('refuses legacy search conversations without snapshot provenance', async () => {
    openIndex({ 'notes/atlas.md': PUBLIC })
    const history = [
      ...exchange(
        'find',
        'search_notes',
        json({ hits: [{ path: 'notes/atlas.md', snippet: 'old text' }] }),
        'Old answer',
      ),
      user('next'),
    ]
    await expect(historyForTarget(history, CLOUD)).rejects.toMatchObject({ kind: 'auth' })
  })

  it('refuses later paraphrases after a folded source is replaced under the same bare name', async () => {
    openIndex(
      {
        'notes/atlas.md': '![[scan.png]]',
        'notes/scan.png.reflect.md': 'New public caption',
        'assets/scan.png.reflect.md': '---\nprivate: true\n---\nOld caption',
      },
      [['notes/atlas.md', 'scan.png']],
    )
    const bridge = getBridge()
    setBridge({
      ...bridge,
      invoke: (command, args) =>
        command === 'list_attachments'
          ? Promise.resolve([{ path: 'notes/scan.png', size: 1, modifiedMs: 1 }])
          : bridge.invoke(command, args),
    })
    const history: ModelMessage[] = [
      ...exchange(
        'find',
        'search_notes',
        json({
          hits: [
            {
              path: 'notes/atlas.md',
              snippet: 'Old caption',
              assetTextHash: await hashContent('Old caption'),
            },
          ],
        }),
        'Old answer',
      ),
      user('repeat it'),
      { role: 'assistant', content: 'A later paraphrase of the old caption' },
      user('next'),
    ]
    await expect(historyForTarget(history, CLOUD, 1)).rejects.toMatchObject({ kind: 'auth' })
  })

  it('keeps a note read whose embedded attachment became private, since reads carry no attachment text', async () => {
    const notes = {
      'notes/atlas.md': '![scan](assets/scan.png)',
      'assets/scan.png.reflect.md': 'Public caption',
    }
    openIndex(notes, [['notes/atlas.md', 'assets/scan.png']])
    notes['assets/scan.png.reflect.md'] = '---\nprivate: true\n---\nPrivate caption'
    const history = [
      ...exchange('atlas?', 'read_notes', readNotes('notes/atlas.md'), 'Atlas answer'),
      user('next'),
    ]
    expect(await historyForTarget(history, CLOUD, 1)).toEqual({
      messages: history,
      withheldTurns: 0,
    })
  })

  it('withholds a legacy caption after its sidecar becomes private before reindexing', async () => {
    const notes = {
      'notes/atlas.md': '![scan](assets/scan.png)',
      'assets/scan.png.reflect.md': 'Public caption',
    }
    openIndex(notes, [['notes/atlas.md', 'assets/scan.png']])
    notes['assets/scan.png.reflect.md'] = '---\nprivate: true\n---\nPrivate caption'
    const history = [
      ...exchange('caption?', 'read_assets', readAssets('assets/scan.png'), 'Caption answer'),
      user('next'),
    ]
    expect(await historyForTarget(history, CLOUD, 1)).toEqual({
      messages: [user('next')],
      withheldTurns: 1,
    })
  })

  it("refuses a cloud turn after an earlier search snippet's sidecar becomes private", async () => {
    const notes = {
      'notes/atlas.md': '![scan](assets/scan.png)',
      'assets/scan.png.reflect.md': 'Public caption',
    }
    openIndex(notes, [['notes/atlas.md', 'assets/scan.png']])
    notes['assets/scan.png.reflect.md'] = '---\nprivate: true\n---\nPrivate caption'
    const history = [
      ...exchange(
        'search?',
        'search_notes',
        json({
          hits: [
            {
              path: 'notes/atlas.md',
              title: 'Atlas',
              snippet: 'Public caption',
              assetTextHash: await hashContent('Public caption'),
            },
          ],
        }),
        'Search answer',
      ),
      user('next'),
    ]
    await expect(historyForTarget(history, CLOUD, 1)).rejects.toMatchObject({ kind: 'auth' })
  })

  it('withholds, rather than refuses, a search with attachment text whose note is locked now', async () => {
    openIndex({ 'notes/atlas.md': PUBLIC, 'notes/x.md': LOCKED })
    const history: ModelMessage[] = [
      ...exchange('atlas?', 'read_notes', readNotes('notes/atlas.md'), 'Atlas ships.'),
      ...exchange(
        'search?',
        'search_notes',
        json({
          hits: [
            {
              path: 'notes/x.md',
              title: 'Diary',
              snippet: 'Old caption',
              assetTextHash: await hashContent('Old caption'),
            },
          ],
        }),
        'Found it.',
      ),
      user('next'),
    ]

    expect(await historyForTarget(history, CLOUD, 1)).toEqual({
      messages: [...history.slice(0, 4), user('next')],
      withheldTurns: 1,
    })
  })

  it('reads each live source once however many exchanges name it', async () => {
    openIndex({ 'notes/atlas.md': PUBLIC })
    const reads: string[] = []
    const bridge = getBridge()
    setBridge({
      ...bridge,
      invoke: (command, args) => {
        if (command === 'note_read_shareable') {
          reads.push(String(args['path']))
        }
        return bridge.invoke(command, args)
      },
    })
    const history: ModelMessage[] = [
      ...exchange('one', 'read_notes', readNotes('notes/atlas.md'), 'One.'),
      ...exchange(
        'two',
        'list_recent_notes',
        json({ ok: true, notes: [listing('notes/atlas.md')] }),
        'Two.',
      ),
      ...exchange('three', 'read_notes', readNotes('notes/atlas.md'), 'Three.'),
      user('next'),
    ]

    expect((await historyForTarget(history, CLOUD)).withheldTurns).toBe(0)
    expect(reads).toEqual(['notes/atlas.md'])
  })

  it('refuses the entire cloud turn when an earlier local result carries private provenance', async () => {
    const history: ModelMessage[] = [
      ...exchange(
        'private?',
        'read_notes',
        json({
          notes: [
            {
              ok: true,
              note: {
                path: 'notes/private.md',
                title: 'Private',
                content: 'secret',
                truncated: false,
                reflectPrivateContext: true,
              },
            },
          ],
        }),
        'Paraphrased secret',
      ),
      user('Send a summary'),
    ]
    await expect(historyForTarget(history, CLOUD)).rejects.toThrow('private local context')
    expect(queries).toHaveLength(0)
  })
  it('leaves out the whole exchange that read a note made private since', async () => {
    openIndex({ 'notes/atlas.md': PUBLIC, 'notes/x.md': LOCKED })
    const history: ModelMessage[] = [
      ...exchange('and atlas?', 'read_notes', readNotes('notes/atlas.md'), 'Atlas ships.'),
      ...exchange('what does x say?', 'read_notes', readNotes('notes/x.md'), 'x says answer-1'),
      user('thanks'),
    ]

    const result = await historyForTarget(history, CLOUD)

    expect(result.withheldTurns).toBe(1)
    expect(result.messages).toEqual([...history.slice(0, 4), user('thanks')])
    const sent = JSON.stringify(result.messages)
    expect(sent).not.toContain('notes/x.md')
    expect(sent).not.toContain('what does x say?')
    expect(sent).not.toContain('answer-1')
  })

  it('leaves out every later exchange too, since an answer can repeat what was withheld', async () => {
    openIndex({ 'notes/atlas.md': PUBLIC, 'notes/x.md': LOCKED })
    const history: ModelMessage[] = [
      ...exchange('atlas?', 'read_notes', readNotes('notes/atlas.md'), 'Atlas ships.'),
      ...exchange('what does x say?', 'read_notes', readNotes('notes/x.md'), 'x says answer-1'),
      user('translate that to French'),
      { role: 'assistant', content: 'x dit answer-1' },
      ...exchange('and atlas again?', 'read_notes', readNotes('notes/atlas.md'), 'Still ships.'),
      user('next'),
    ]

    const result = await historyForTarget(history, CLOUD)

    expect(result).toEqual({
      messages: [...history.slice(0, 4), user('next')],
      withheldTurns: 3,
    })
    expect(JSON.stringify(result.messages)).not.toContain('answer-1')
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
        json({
          hits: [
            {
              path: 'notes/atlas.md',
              title: 'Atlas',
              snippet: 'launch',
              assetTextHash: await hashContent(''),
            },
          ],
        }),
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
        json({
          hits: [
            {
              path: 'notes/x.md',
              title: 'Diary',
              snippet: 'secret',
              assetTextHash: await hashContent(''),
            },
          ],
        }),
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

    expect(result.withheldTurns).toBe(3)
    expect(result.messages).toEqual([user('next')])
  })

  it('keeps the roles alternating around the exchanges it leaves out', async () => {
    openIndex({ 'notes/atlas.md': PUBLIC, 'notes/x.md': LOCKED })
    const history: ModelMessage[] = [
      ...exchange('one', 'read_notes', readNotes('notes/atlas.md'), 'One.'),
      user('two'),
      { role: 'assistant', content: 'Two.' },
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
      user('two'),
      user('five'),
    ])
  })

  it('sends an on-device model the full history without asking the index', async () => {
    openIndex({ 'notes/x.md': LOCKED })
    const history: ModelMessage[] = [
      ...exchange('x?', 'read_notes', readNotes('notes/x.md'), 'x.'),
      user('next'),
    ]

    verifyOnDeviceServerMock.mockResolvedValueOnce('ok')
    const result = await historyForTarget(history, await verifyModelTarget(ON_DEVICE, ''))

    expect(result.withheldTurns).toBe(0)
    expect(result.messages).toBe(history)
    expect(queries).toHaveLength(0)
    expect(verifyOnDeviceServerMock).toHaveBeenCalledExactlyOnceWith(ON_DEVICE, {
      apiKey: '',
      signal: undefined,
    })
  })

  it('refuses verification instead of downgrading an on-device conversation', async () => {
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

    await expect(verifyModelTarget(ON_DEVICE, '')).rejects.toThrow(
      'This model runs in Ollama’s cloud.',
    )
    expect(history).toHaveLength(9)
    expect(queries).toHaveLength(0)
  })

  it('checks every named note and asset against the index and live files', async () => {
    openIndex(
      {
        'notes/a.md': PUBLIC,
        'notes/b.md': PUBLIC,
        'notes/c.md': `${PUBLIC}\n![[assets/chart.png]]`,
      },
      [['notes/c.md', 'assets/chart.png']],
    )
    const history: ModelMessage[] = [
      ...exchange('a', 'read_notes', readNotes('notes/a.md', 'notes/b.md'), 'A.'),
      ...exchange(
        'b',
        'search_notes',
        json({
          hits: [
            { path: 'notes/b.md', title: 'B', assetTextHash: await hashContent('') },
            { path: 'notes/c.md', title: 'C', assetTextHash: await hashContent('') },
          ],
        }),
        'B.',
      ),
      ...exchange('c', 'read_assets', readAssets('assets/chart.png'), 'C.'),
      user('next'),
    ]

    expect((await historyForTarget(history, CLOUD)).withheldTurns).toBe(0)
    expect(queries.length).toBeGreaterThan(0)
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
        'legacy recents',
        'list_recent_notes',
        json({ notes: [listing('notes/atlas.md')] }),
        'Atlas.',
      ),
      ...exchange(
        'legacy read',
        'read_note',
        json({ ok: true, note: { path: 'notes/x.md', title: 'Diary', content: 'x' } }),
        'Diary.',
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
    // Nothing after the first unreadable exchange is checked.
    expect(queries).toHaveLength(0)
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
