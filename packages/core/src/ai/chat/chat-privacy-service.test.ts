import type { ModelMessage } from '@reflect/modules/ai'
import { sha256Hex } from '@reflect/utils'
import { describe, expect, it } from 'vitest'
import { createAssetPrivacyService } from '../../assets/asset-privacy-service.ts'
import { AppError } from '../../errors.ts'
import {
  createLocalOnlyFolders,
  isLocalOnlyPath,
  NO_LOCAL_ONLY_FOLDERS,
} from '../../graph/local-only.ts'
import { createAssetReferences } from '../../indexing/asset-refs.ts'
import { project } from '../../indexing/flow-test-harness.ts'
import { cloudTarget, modelTarget } from '../../privacy/on-device.ts'
import { overrideNoteFileService } from '../../testing/graph.ts'
import {
  createNodeTestDatabaseService,
  createTestAssetStoreService,
  createTestGraphSessionService,
  createTestNoteFileService,
  createTestOnDeviceModelService,
  createTestXArchiveService,
} from '../../testing/index.ts'
import { createChatPrivacyService, type ChatPrivacyScope } from './chat-privacy-service.ts'

/**
 * The chat privacy checks over a real index: notes are projected from
 * Markdown into the production schema, and the checks read them back
 * through the test database, whose queries are counted. Live sources answer
 * from the same Markdown through the shareable read, which Rust refuses for
 * a local-only note however its path is spelled.
 */

type ToolMessage = Extract<ModelMessage, { role: 'tool' }>
type ToolResultOutput = Extract<ToolMessage['content'][number], { type: 'tool-result' }>['output']
type JsonValue = Extract<ToolResultOutput, { type: 'json' }>['value']

const CLOUD = cloudTarget({ id: 'openai', provider: 'openai', model: 'gpt-5.5', keyHint: 'wxyz1' })
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

interface IndexOptions {
  /**
   * `[notePath, assetPath]` rows of the index's `assets` projection.
   */
  assets?: readonly (readonly [notePath: string, assetPath: string])[]
  /**
   * The attachments a bare filename resolves against.
   */
  attachments?: readonly string[]
  /**
   * The graph's local-only folders.
   */
  localOnlyFolders?: readonly string[]
  /**
   * Indexed attachment-text hashes, by note path.
   */
  assetTextHashes?: Readonly<Record<string, string>>
  /**
   * Device-only OCR cache entries, by the SHA-256 of their asset path.
   */
  ocrCache?: Readonly<Record<string, string>>
}

/**
 * The service over a migrated index holding `notes` (path → Markdown, which
 * also answers the live reads) and the given asset references.
 */
async function openIndex(notes: Record<string, string>, options: IndexOptions = {}) {
  const database = createNodeTestDatabaseService()
  for (const [path, source] of Object.entries(notes)) {
    database.applyProjection(project(path, source, 1))
  }
  for (const [notePath, assetPath] of options.assets ?? []) {
    await database.runQuery('INSERT INTO assets(note_path, asset_path) VALUES (?, ?)', [
      notePath,
      assetPath,
    ])
  }
  for (const [path, hash] of Object.entries(options.assetTextHashes ?? {})) {
    await database.runQuery('UPDATE notes SET asset_text_hash = ? WHERE path = ?', [hash, path])
  }
  const seeded = database.getQueries().length
  const localOnly = createLocalOnlyFolders(options.localOnlyFolders ?? [])
  const reads: string[] = []
  const noteFile = overrideNoteFileService(createTestNoteFileService(), {
    readShareable: (path) => {
      reads.push(path)
      if (isLocalOnlyPath(localOnly, path)) {
        return Promise.resolve({ kind: 'localOnly' })
      }
      const content = notes[path]
      if (content === undefined) {
        return Promise.reject(new AppError('notFound', `${path} not found`))
      }
      return Promise.resolve({ kind: 'content', content })
    },
    listAttachments: () => {
      return Promise.resolve(
        (options.attachments ?? []).map((path) => ({ path, size: 1, modifiedMs: 1 })),
      )
    },
  })
  const xArchive = createTestXArchiveService()
  const assetReferences = createAssetReferences({ database, xArchive })
  const privacy = createChatPrivacyService({
    database,
    noteFile,
    assetStore: createTestAssetStoreService({ ocrCache: options.ocrCache ?? {} }),
    assetReferences,
    assetPrivacy: createAssetPrivacyService({
      noteFile,
      xArchive,
      assetReferences,
      graphSession: createTestGraphSessionService({
        graph: { generation: 1, localOnlyFolders: [...(options.localOnlyFolders ?? [])] },
      }),
    }),
  })
  const scope: ChatPrivacyScope = { generation: 1, localOnly }
  return {
    privacy,
    scope,
    reads,
    /**
     * How many index queries the checks ran.
     */
    queries: (): number => database.getQueries().length - seeded,
  }
}

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
    const { privacy, scope } = await openIndex({ 'notes/atlas.md': PUBLIC })
    const history = [
      ...exchange(
        'find',
        'search_notes',
        json({ hits: [{ path: 'notes/atlas.md', snippet: 'old text' }] }),
        'Old answer',
      ),
      user('next'),
    ]
    await expect(privacy.historyForTarget(history, CLOUD, scope)).rejects.toMatchObject({
      kind: 'auth',
    })
  })

  it('refuses later paraphrases after a folded source is replaced under the same bare name', async () => {
    const { privacy, scope } = await openIndex(
      {
        'notes/atlas.md': '![[scan.png]]',
        'notes/scan.png.reflect.md': 'New public caption',
        'assets/scan.png.reflect.md': '---\nprivate: true\n---\nOld caption',
      },
      { assets: [['notes/atlas.md', 'scan.png']], attachments: ['notes/scan.png'] },
    )
    const history: ModelMessage[] = [
      ...exchange(
        'find',
        'search_notes',
        json({
          hits: [
            {
              path: 'notes/atlas.md',
              snippet: 'Old caption',
              assetTextHash: await sha256Hex('Old caption'),
            },
          ],
        }),
        'Old answer',
      ),
      user('repeat it'),
      { role: 'assistant', content: 'A later paraphrase of the old caption' },
      user('next'),
    ]
    await expect(privacy.historyForTarget(history, CLOUD, scope)).rejects.toMatchObject({
      kind: 'auth',
    })
  })

  it('keeps a note read whose embedded attachment became private, since reads carry no attachment text', async () => {
    const notes = {
      'notes/atlas.md': '![scan](assets/scan.png)',
      'assets/scan.png.reflect.md': 'Public caption',
    }
    const { privacy, scope } = await openIndex(notes, {
      assets: [['notes/atlas.md', 'assets/scan.png']],
    })
    notes['assets/scan.png.reflect.md'] = '---\nprivate: true\n---\nPrivate caption'
    const history = [
      ...exchange('atlas?', 'read_notes', readNotes('notes/atlas.md'), 'Atlas answer'),
      user('next'),
    ]
    expect(await privacy.historyForTarget(history, CLOUD, scope)).toEqual({
      messages: history,
      withheldTurns: 0,
    })
  })

  it('withholds a legacy caption after its sidecar becomes private before reindexing', async () => {
    const notes = {
      'notes/atlas.md': '![scan](assets/scan.png)',
      'assets/scan.png.reflect.md': 'Public caption',
    }
    const { privacy, scope } = await openIndex(notes, {
      assets: [['notes/atlas.md', 'assets/scan.png']],
    })
    notes['assets/scan.png.reflect.md'] = '---\nprivate: true\n---\nPrivate caption'
    const history = [
      ...exchange('caption?', 'read_assets', readAssets('assets/scan.png'), 'Caption answer'),
      user('next'),
    ]
    expect(await privacy.historyForTarget(history, CLOUD, scope)).toEqual({
      messages: [user('next')],
      withheldTurns: 1,
    })
  })

  it("refuses a cloud turn after an earlier search snippet's sidecar becomes private", async () => {
    const notes = {
      'notes/atlas.md': '![scan](assets/scan.png)',
      'assets/scan.png.reflect.md': 'Public caption',
    }
    const { privacy, scope } = await openIndex(notes, {
      assets: [['notes/atlas.md', 'assets/scan.png']],
    })
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
              assetTextHash: await sha256Hex('Public caption'),
            },
          ],
        }),
        'Search answer',
      ),
      user('next'),
    ]
    await expect(privacy.historyForTarget(history, CLOUD, scope)).rejects.toMatchObject({
      kind: 'auth',
    })
  })

  it('withholds, rather than refuses, a search with attachment text whose note is locked now', async () => {
    const { privacy, scope } = await openIndex({ 'notes/atlas.md': PUBLIC, 'notes/x.md': LOCKED })
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
              assetTextHash: await sha256Hex('Old caption'),
            },
          ],
        }),
        'Found it.',
      ),
      user('next'),
    ]

    expect(await privacy.historyForTarget(history, CLOUD, scope)).toEqual({
      messages: [...history.slice(0, 4), user('next')],
      withheldTurns: 1,
    })
  })

  it('reads each live source once however many exchanges name it', async () => {
    const { privacy, scope, reads } = await openIndex({ 'notes/atlas.md': PUBLIC })
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

    expect((await privacy.historyForTarget(history, CLOUD, scope)).withheldTurns).toBe(0)
    expect(reads).toEqual(['notes/atlas.md'])
  })

  it('refuses the entire cloud turn when an earlier local result carries private provenance', async () => {
    const { privacy, scope, queries } = await openIndex({})
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
    await expect(privacy.historyForTarget(history, CLOUD, scope)).rejects.toThrow(
      'private local context',
    )
    expect(queries()).toBe(0)
  })

  it('leaves out the whole exchange that read a note made private since', async () => {
    const { privacy, scope } = await openIndex({ 'notes/atlas.md': PUBLIC, 'notes/x.md': LOCKED })
    const history: ModelMessage[] = [
      ...exchange('and atlas?', 'read_notes', readNotes('notes/atlas.md'), 'Atlas ships.'),
      ...exchange('what does x say?', 'read_notes', readNotes('notes/x.md'), 'x says answer-1'),
      user('thanks'),
    ]

    const result = await privacy.historyForTarget(history, CLOUD, scope)

    expect(result.withheldTurns).toBe(1)
    expect(result.messages).toEqual([...history.slice(0, 4), user('thanks')])
    const sent = JSON.stringify(result.messages)
    expect(sent).not.toContain('notes/x.md')
    expect(sent).not.toContain('what does x say?')
    expect(sent).not.toContain('answer-1')
  })

  it('leaves out every later exchange too, since an answer can repeat what was withheld', async () => {
    const { privacy, scope } = await openIndex({ 'notes/atlas.md': PUBLIC, 'notes/x.md': LOCKED })
    const history: ModelMessage[] = [
      ...exchange('atlas?', 'read_notes', readNotes('notes/atlas.md'), 'Atlas ships.'),
      ...exchange('what does x say?', 'read_notes', readNotes('notes/x.md'), 'x says answer-1'),
      user('translate that to French'),
      { role: 'assistant', content: 'x dit answer-1' },
      ...exchange('and atlas again?', 'read_notes', readNotes('notes/atlas.md'), 'Still ships.'),
      user('next'),
    ]

    const result = await privacy.historyForTarget(history, CLOUD, scope)

    expect(result).toEqual({
      messages: [...history.slice(0, 4), user('next')],
      withheldTurns: 3,
    })
    expect(JSON.stringify(result.messages)).not.toContain('answer-1')
  })

  it('leaves out an exchange that read a note in a folder made local-only', async () => {
    // Indexed while still public: the folder rule alone makes it private.
    const { privacy, scope, queries } = await openIndex(
      { 'journal/x.md': PUBLIC },
      { localOnlyFolders: ['journal'] },
    )
    const history: ModelMessage[] = [
      ...exchange('x?', 'read_notes', readNotes('journal/x.md'), 'x.'),
      user('next'),
    ]

    expect(await privacy.historyForTarget(history, CLOUD, scope)).toEqual({
      messages: [user('next')],
      withheldTurns: 1,
    })
    // A local-only path needs no index row to count as private.
    expect(queries()).toBe(0)
  })

  it('counts a note with no index row as private', async () => {
    const { privacy, scope } = await openIndex({ 'notes/atlas.md': PUBLIC })
    const history: ModelMessage[] = [
      ...exchange('moved?', 'read_notes', readNotes('notes/moved.md'), 'Moved.'),
      user('next'),
    ]

    expect((await privacy.historyForTarget(history, CLOUD, scope)).withheldTurns).toBe(1)
  })

  it('keeps exchanges whose searches and listings named only public notes', async () => {
    const { privacy, scope } = await openIndex({
      'notes/atlas.md': PUBLIC,
      'daily/2026-06-01.md': '# June\n',
    })
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
              assetTextHash: await sha256Hex(''),
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

    const result = await privacy.historyForTarget(history, CLOUD, scope)

    expect(result).toEqual({ messages: history, withheldTurns: 0 })
    // Nothing left out: the turn sends the very array it was given.
    expect(result.messages).toBe(history)
  })

  it('leaves out searches and listings that named a note private now', async () => {
    const { privacy, scope } = await openIndex({ 'notes/atlas.md': PUBLIC, 'notes/x.md': LOCKED })
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
              assetTextHash: await sha256Hex(''),
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

    const result = await privacy.historyForTarget(history, CLOUD, scope)

    expect(result.withheldTurns).toBe(3)
    expect(result.messages).toEqual([user('next')])
  })

  it('keeps the roles alternating around the exchanges it leaves out', async () => {
    const { privacy, scope } = await openIndex({ 'notes/atlas.md': PUBLIC, 'notes/x.md': LOCKED })
    const history: ModelMessage[] = [
      ...exchange('one', 'read_notes', readNotes('notes/atlas.md'), 'One.'),
      user('two'),
      { role: 'assistant', content: 'Two.' },
      ...exchange('three', 'read_notes', readNotes('notes/atlas.md', 'notes/x.md'), 'Three.'),
      user('four'),
      { role: 'assistant', content: 'Four.' },
      user('five'),
    ]

    const { messages } = await privacy.historyForTarget(history, CLOUD, scope)

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
    const { privacy, scope, queries } = await openIndex({ 'notes/x.md': LOCKED })
    const history: ModelMessage[] = [
      ...exchange('x?', 'read_notes', readNotes('notes/x.md'), 'x.'),
      user('next'),
    ]
    const onDeviceModels = createTestOnDeviceModelService()

    const result = await privacy.historyForTarget(
      history,
      await onDeviceModels.verify(ON_DEVICE, ''),
      scope,
    )

    expect(result.withheldTurns).toBe(0)
    expect(result.messages).toBe(history)
    expect(queries()).toBe(0)
    expect(onDeviceModels.verifyCalls()).toEqual([{ target: ON_DEVICE, apiKey: '' }])
  })

  it('refuses verification instead of downgrading an on-device conversation', async () => {
    const { queries } = await openIndex({ 'notes/atlas.md': PUBLIC, 'notes/x.md': LOCKED })
    const onDeviceModels = createTestOnDeviceModelService({
      verdict: { kind: 'refused', reason: 'This model runs in Ollama’s cloud.' },
    })
    const history: ModelMessage[] = [
      ...exchange('x?', 'read_notes', readNotes('notes/x.md'), 'x.'),
      ...exchange('atlas?', 'read_notes', readNotes('notes/atlas.md'), 'Atlas.'),
      user('next'),
    ]

    await expect(onDeviceModels.verify(ON_DEVICE, '')).rejects.toThrow(
      'This model runs in Ollama’s cloud.',
    )
    expect(history).toHaveLength(9)
    expect(queries()).toBe(0)
  })

  it('checks every named note and asset against the index and live files', async () => {
    const { privacy, scope, queries } = await openIndex(
      {
        'notes/a.md': PUBLIC,
        'notes/b.md': PUBLIC,
        'notes/c.md': `${PUBLIC}\n![[assets/chart.png]]`,
      },
      { assets: [['notes/c.md', 'assets/chart.png']] },
    )
    const history: ModelMessage[] = [
      ...exchange('a', 'read_notes', readNotes('notes/a.md', 'notes/b.md'), 'A.'),
      ...exchange(
        'b',
        'search_notes',
        json({
          hits: [
            { path: 'notes/b.md', title: 'B', assetTextHash: await sha256Hex('') },
            { path: 'notes/c.md', title: 'C', assetTextHash: await sha256Hex('') },
          ],
        }),
        'B.',
      ),
      ...exchange('c', 'read_assets', readAssets('assets/chart.png'), 'C.'),
      user('next'),
    ]

    expect((await privacy.historyForTarget(history, CLOUD, scope)).withheldTurns).toBe(0)
    expect(queries()).toBeGreaterThan(0)
  })

  it('asks the index nothing when no earlier exchange read anything', async () => {
    const { privacy, scope, queries } = await openIndex({})
    const history: ModelMessage[] = [
      user('hi'),
      { role: 'assistant', content: 'Hello.' },
      user('next'),
    ]

    expect((await privacy.historyForTarget(history, CLOUD, scope)).messages).toBe(history)
    expect(queries()).toBe(0)
  })

  it('ignores refused reads and tool errors, which hold nothing read from a note', async () => {
    const { privacy, scope } = await openIndex({ 'notes/atlas.md': PUBLIC })
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

    expect((await privacy.historyForTarget(history, CLOUD, scope)).withheldTurns).toBe(0)
  })

  it('reads the result shapes older builds persisted', async () => {
    const { privacy, scope } = await openIndex({ 'notes/atlas.md': PUBLIC, 'notes/x.md': LOCKED })
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

    const result = await privacy.historyForTarget(history, CLOUD, scope)

    expect(result.withheldTurns).toBe(1)
    expect(result.messages[0]).toEqual(user('legacy recents'))
  })
})

describe('historyForTarget over asset reads', () => {
  it('leaves out an asset read once a note embedding it is private', async () => {
    const { privacy, scope } = await openIndex(
      { 'notes/public.md': PUBLIC, 'notes/x.md': LOCKED },
      {
        assets: [
          ['notes/public.md', 'assets/scan.png'],
          ['notes/x.md', 'assets/scan.png'],
        ],
      },
    )
    const history: ModelMessage[] = [
      ...exchange('scan?', 'read_assets', readAssets('assets/scan.png'), 'A scan.'),
      user('next'),
    ]

    expect((await privacy.historyForTarget(history, CLOUD, scope)).withheldTurns).toBe(1)
  })

  it('matches a note that embeds the asset by bare filename', async () => {
    const { privacy, scope } = await openIndex(
      { 'notes/public.md': PUBLIC, 'notes/x.md': LOCKED },
      {
        assets: [
          ['notes/public.md', 'assets/scan.png'],
          ['notes/x.md', 'scan.png'],
        ],
      },
    )
    const history: ModelMessage[] = [
      ...exchange('scan?', 'read_assets', readAssets('assets/scan.png'), 'A scan.'),
      user('next'),
    ]

    expect((await privacy.historyForTarget(history, CLOUD, scope)).withheldTurns).toBe(1)
  })

  it('keeps an asset read while every note embedding it is public', async () => {
    const { privacy, scope } = await openIndex(
      { 'notes/a.md': PUBLIC, 'notes/b.md': PUBLIC },
      {
        assets: [
          ['notes/a.md', 'assets/scan.png'],
          ['notes/b.md', 'scan.png'],
        ],
      },
    )
    const history: ModelMessage[] = [
      ...exchange('scan?', 'read_assets', readAssets('assets/scan.png'), 'A scan.'),
      user('next'),
    ]

    expect((await privacy.historyForTarget(history, CLOUD, scope)).withheldTurns).toBe(0)
  })

  it('counts an asset no indexed note embeds as private', async () => {
    const { privacy, scope } = await openIndex({ 'notes/a.md': PUBLIC })
    const history: ModelMessage[] = [
      ...exchange('scan?', 'read_assets', readAssets('assets/orphan.png'), 'A scan.'),
      user('next'),
    ]

    expect((await privacy.historyForTarget(history, CLOUD, scope)).withheldTurns).toBe(1)
  })

  it('counts an asset embedded from a folder made local-only as private', async () => {
    const { privacy, scope } = await openIndex(
      { 'journal/n.md': PUBLIC },
      { assets: [['journal/n.md', 'assets/scan.png']], localOnlyFolders: ['journal'] },
    )
    const history: ModelMessage[] = [
      ...exchange('scan?', 'read_assets', readAssets('assets/scan.png'), 'A scan.'),
      user('next'),
    ]

    expect((await privacy.historyForTarget(history, CLOUD, scope)).withheldTurns).toBe(1)
  })

  it('leaves out an X media read once a note linking the post that owns it is locked', async () => {
    // A public note embeds the media directly; the locked note links the X
    // post, which the index records as the post's archive file.
    const { privacy, scope } = await openIndex(
      { 'notes/public.md': PUBLIC, 'notes/x.md': LOCKED },
      {
        assets: [
          ['notes/public.md', 'assets/x/abc.jpg'],
          ['notes/x.md', 'assets/x/post-1.json'],
        ],
      },
    )
    const history: ModelMessage[] = [
      ...exchange('photo?', 'read_assets', readAssets('assets/x/abc.jpg'), 'A photo.'),
      user('next'),
    ]

    expect((await privacy.historyForTarget(history, CLOUD, scope)).withheldTurns).toBe(1)
  })

  it('counts every X media file as private, since the index does not know its owners', async () => {
    const { privacy, scope, queries } = await openIndex(
      { 'notes/public.md': PUBLIC, 'notes/post.md': PUBLIC },
      {
        assets: [
          ['notes/public.md', 'assets/x/abc.jpg'],
          ['notes/post.md', 'assets/x/post-1.json'],
        ],
      },
    )
    const history: ModelMessage[] = [
      ...exchange('photo?', 'read_assets', readAssets('assets/x/abc.jpg'), 'A photo.'),
      user('next'),
    ]

    expect((await privacy.historyForTarget(history, CLOUD, scope)).withheldTurns).toBe(1)
    expect(queries()).toBe(0)
  })
})

describe('historyForTarget fails closed', () => {
  it('leaves out an exchange whose tool it does not know', async () => {
    const { privacy, scope } = await openIndex({ 'notes/atlas.md': PUBLIC })
    const history: ModelMessage[] = [
      ...exchange('mystery', 'summarize_notes', json({ notes: [] }), 'Done.'),
      user('next'),
    ]

    expect((await privacy.historyForTarget(history, CLOUD, scope)).withheldTurns).toBe(1)
  })

  it('leaves out an exchange whose tool output does not parse', async () => {
    const { privacy, scope, queries } = await openIndex({ 'notes/atlas.md': PUBLIC })
    const history: ModelMessage[] = [
      ...exchange('bad', 'read_notes', json({ notes: 'notes/atlas.md' }), 'Atlas.'),
      ...exchange('text', 'read_notes', { type: 'text', value: 'notes/atlas.md' }, 'Atlas.'),
      user('next'),
    ]

    expect((await privacy.historyForTarget(history, CLOUD, scope)).withheldTurns).toBe(2)
    // Nothing after the first unreadable exchange is checked.
    expect(queries()).toBe(0)
  })

  it('leaves out an exchange whose stored tool message is malformed', async () => {
    const { privacy, scope } = await openIndex({ 'notes/atlas.md': PUBLIC })
    // Stored rows are validated by envelope only, so content can be anything.
    const malformed = JSON.parse('{"role":"tool","content":{"path":"notes/x.md"}}') as ModelMessage
    const history: ModelMessage[] = [user('corrupt'), malformed, user('next')]

    expect(await privacy.historyForTarget(history, CLOUD, scope)).toEqual({
      messages: [user('next')],
      withheldTurns: 1,
    })
  })
})

describe('hasRestrictedSearchSources', () => {
  /** The service and the reader of a graph whose live sources are `notes`. */
  async function searchFixture(notes: Record<string, string>, options: IndexOptions = {}) {
    const fixture = await openIndex(notes, options)
    const readNote = (path: string): Promise<string> => {
      const content = notes[path]
      if (content === undefined) {
        return Promise.reject(new AppError('notFound', 'missing'))
      }
      return Promise.resolve(content)
    }
    return { ...fixture, readNote }
  }

  it('checks the hit snapshot when an old bare source disappears and a public replacement takes its name', async () => {
    const source = '![[scan.png]]'
    const { privacy, readNote } = await searchFixture(
      {
        'notes/a.md': source,
        'notes/scan.png.reflect.md': 'New public caption',
        'assets/scan.png.reflect.md': '---\nprivate: true\n---\nOld caption',
      },
      {
        assets: [['notes/a.md', 'scan.png']],
        attachments: ['notes/scan.png'],
        assetTextHashes: { 'notes/a.md': await sha256Hex('New public caption') },
      },
    )
    const scope = { readNote, generation: 1, localOnly: NO_LOCAL_ONLY_FOLDERS }

    expect(
      await privacy.hasRestrictedSearchSources('notes/a.md', source, {
        ...scope,
        expectedAssetTextHash: await sha256Hex('Old caption'),
      }),
    ).toBe(true)
    expect(
      await privacy.hasRestrictedSearchSources('notes/a.md', source, {
        ...scope,
        expectedAssetTextHash: await sha256Hex('New public caption'),
      }),
    ).toBe(false)
  })

  it('withholds an unresolved bare reference after its caption source disappears', async () => {
    const source = '![[scan.png]]'
    const { privacy, readNote } = await searchFixture({
      'notes/a.md': source,
      'assets/scan.png.reflect.md': '---\nprivate: true\n---\nPreviously public caption',
    })

    expect(
      await privacy.hasRestrictedSearchSources('notes/a.md', source, {
        readNote,
        generation: 1,
        localOnly: NO_LOCAL_ONLY_FOLDERS,
      }),
    ).toBe(true)
  })

  it('checks the earlier bare-reference candidate when a new file takes resolution precedence', async () => {
    const source = '![[scan.png]]'
    const { privacy, readNote } = await searchFixture(
      {
        'notes/a.md': source,
        'assets/scan.png.reflect.md': '---\nprivate: true\n---\nPreviously folded caption',
        'notes/scan.png.reflect.md': 'New public caption',
      },
      {
        assets: [['notes/a.md', 'scan.png']],
        attachments: ['assets/scan.png', 'notes/scan.png'],
      },
    )

    expect(
      await privacy.hasRestrictedSearchSources('notes/a.md', source, {
        readNote,
        generation: 1,
        localOnly: NO_LOCAL_ONLY_FOLDERS,
      }),
    ).toBe(true)
  })

  it('counts an attachment in a local-only folder as restricted without reading it', async () => {
    const source = '![scan](secure/scan.png)'
    const { privacy, readNote, reads } = await searchFixture({ 'notes/a.md': source })

    expect(
      await privacy.hasRestrictedSearchSources('notes/a.md', source, {
        readNote,
        generation: 1,
        localOnly: createLocalOnlyFolders(['secure']),
      }),
    ).toBe(true)
    expect(reads).toEqual([])
  })

  it('counts an attachment with device-only OCR text as restricted', async () => {
    const source = '![chart](assets/chart.png)'
    const { privacy, readNote } = await searchFixture(
      { 'notes/a.md': source, 'assets/chart.png.reflect.md': 'A public chart.' },
      {
        assets: [['notes/a.md', 'assets/chart.png']],
        ocrCache: {
          [await sha256Hex('assets/chart.png')]: JSON.stringify({
            version: 1,
            status: 'invalid',
            deviceOnly: true,
            assetPath: 'assets/chart.png',
          }),
        },
      },
    )

    expect(
      await privacy.hasRestrictedSearchSources('notes/a.md', source, {
        readNote,
        generation: 1,
        localOnly: NO_LOCAL_ONLY_FOLDERS,
      }),
    ).toBe(true)
  })

  it('clears public attachments whose text still matches the snapshot', async () => {
    const source = '![chart](assets/chart.png)'
    const { privacy, readNote } = await searchFixture(
      { 'notes/a.md': source, 'assets/chart.png.reflect.md': 'A public chart.' },
      { assets: [['notes/a.md', 'assets/chart.png']] },
    )
    const options = { readNote, generation: 1, localOnly: NO_LOCAL_ONLY_FOLDERS }

    expect(await privacy.hasRestrictedSearchSources('notes/a.md', source, options)).toBe(false)
    expect(
      await privacy.hasRestrictedSearchSources('notes/a.md', source, {
        ...options,
        expectedAssetTextHash: await sha256Hex('An older caption.'),
      }),
    ).toBe(true)
  })
})

describe('snapshotHasAttachmentText', () => {
  it('reads only the empty text hash as holding no attachment text', async () => {
    const { privacy } = await openIndex({})

    expect(await privacy.snapshotHasAttachmentText(await sha256Hex(''))).toBe(false)
    expect(await privacy.snapshotHasAttachmentText(await sha256Hex('caption'))).toBe(true)
    // A snapshot from an older build has no hash and fails closed.
    expect(await privacy.snapshotHasAttachmentText(undefined)).toBe(true)
  })
})
