import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { MockLanguageModelV3 } from '@reflect/modules/ai/test'
import type { LanguageModelV3CallOptions, LanguageModelV3Usage } from '@ai-sdk/provider'
import { languageModelFor } from '../ai/language-model.ts'
import { aiApiKeyForConfig } from '../ai/secrets.ts'
import { readNoteLocal, writeNoteKeepingModified } from '../graph/commands.ts'
import {
  applyProjection,
  connectIndex,
  openMigratedIndex,
  project,
} from '../indexing/flow-test-harness.ts'
import { noteBodyHash, parseNote, splitFrontmatter, upsertFrontmatter } from '../markdown/index.ts'
import { verifyOnDeviceServer } from '../privacy/on-device.ts'
import type { AiProviderConfig, OpenAiCompatibleProviderConfig } from '../settings/schema.ts'
import { testTargetModel } from '../testing/target-model.ts'
import {
  noteSummaryKey,
  reconcileNoteSummaries,
  SUMMARY_QUIET_MS,
  type ReconcileNoteSummariesInput,
} from './note-summaries.ts'

vi.mock('../graph/commands', async (original) => ({
  ...(await original<typeof import('../graph/commands.ts')>()),
  readNoteLocal: vi.fn(),
  writeNoteKeepingModified: vi.fn(),
}))
vi.mock('../ai/language-model', async (original) => ({
  ...(await original<typeof import('../ai/language-model.ts')>()),
  languageModelFor: vi.fn(),
}))
vi.mock('../ai/secrets', () => ({ aiApiKeyForConfig: vi.fn() }))
vi.mock('../privacy/on-device-verification', () => ({ verifyOnDeviceServer: vi.fn() }))

const USAGE: LanguageModelV3Usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
}

const LOCAL: OpenAiCompatibleProviderConfig = {
  id: 'local',
  provider: 'openai-compatible',
  model: 'llama:latest',
  baseUrl: 'http://localhost:11434/v1',
  keyHint: '',
  onDevice: { model: 'llama:latest', baseUrl: 'http://localhost:11434/v1', server: 'ollama' },
}

const CLOUD: AiProviderConfig = {
  id: 'cloud',
  provider: 'anthropic',
  model: 'claude-opus-4-8',
  keyHint: 'wxyz1',
}

const NOW = 2_000_000_000_000
const SETTLED_MTIME = NOW - 2 * SUMMARY_QUIET_MS
const LONG_BODY = `# Long\n\n${'A sentence that keeps the note going. '.repeat(30)}\n`

const PUBLIC = 'notes/public.md'
const PRIVATE = 'notes/private.md'
const SHORT = 'notes/short.md'
const RECENT = 'notes/recent.md'

let database: DatabaseSync
let files: Map<string, string>
let calls: LanguageModelV3CallOptions[]

function addNote(path: string, source: string, mtime = SETTLED_MTIME): void {
  files.set(path, source)
  applyProjection(database, project(path, source, mtime))
}

function input(overrides: Partial<ReconcileNoteSummariesInput> = {}): ReconcileNoteSummariesInput {
  return {
    providers: { providers: [LOCAL, CLOUD], defaultProviderId: CLOUD.id },
    mode: 'local',
    generation: 1,
    now: () => NOW,
    ...overrides,
  }
}

function writtenPaths(): string[] {
  return vi.mocked(writeNoteKeepingModified).mock.calls.map(([path]) => path)
}

beforeEach(() => {
  vi.resetAllMocks()
  database = openMigratedIndex()
  connectIndex(database)
  files = new Map()
  calls = []
  addNote(PUBLIC, LONG_BODY)
  addNote(PRIVATE, `---\nprivate: true\n---\n${LONG_BODY}`)
  addNote(SHORT, '# Short\n\nA few words.\n')
  addNote(RECENT, LONG_BODY, NOW - 1_000)

  vi.mocked(readNoteLocal).mockImplementation(async (path) => {
    const content = files.get(path)
    if (content === undefined) {
      throw Object.assign(new Error('missing'), { kind: 'notFound' })
    }
    return { kind: 'content', content, localOnly: false }
  })
  vi.mocked(aiApiKeyForConfig).mockResolvedValue('')
  vi.mocked(verifyOnDeviceServer).mockResolvedValue('ok')
  vi.mocked(languageModelFor).mockImplementation(async (target) =>
    testTargetModel(
      target,
      new MockLanguageModelV3({
        doGenerate: async (options) => {
          calls.push(options)
          return {
            content: [{ type: 'text', text: `Summary from ${target.kind}.` }],
            finishReason: { unified: 'stop' as const, raw: undefined },
            usage: USAGE,
            warnings: [],
          }
        },
      }),
    ),
  )
})

describe('reconcileNoteSummaries', () => {
  it('summarizes long settled notes on-device, private ones included', async () => {
    const outcome = await reconcileNoteSummaries(input())

    expect(outcome.stopped).toBeNull()
    expect(outcome.summarized).toBe(2)
    expect(writtenPaths().sort()).toEqual([PRIVATE, PUBLIC])
    expect(outcome.nextDueAt).toBe(NOW - 1_000 + SUMMARY_QUIET_MS)

    const [path, written, generation, expected] = vi.mocked(writeNoteKeepingModified).mock.calls[0]!
    expect(generation).toBe(1)
    expect(expected).toBe(files.get(path))
    const body = splitFrontmatter(written).body
    expect(body).toBe(splitFrontmatter(files.get(path)!).body)
    expect(parseNote({ path, source: written }).frontmatter.aiSummary).toEqual({
      text: 'Summary from on-device.',
      hash: noteBodyHash(body),
    })
  })

  it('stops without a usable on-device model in local mode', async () => {
    const outcome = await reconcileNoteSummaries(
      input({ providers: { providers: [CLOUD], defaultProviderId: CLOUD.id } }),
    )
    expect(outcome.stopped?.reason).toBe('config')
    expect(writeNoteKeepingModified).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)
  })

  it('falls back to the cloud small model for public notes only, when opted in', async () => {
    vi.mocked(verifyOnDeviceServer).mockResolvedValue({ kind: 'refused', reason: 'down' })
    const outcome = await reconcileNoteSummaries(input({ mode: 'local-and-cloud' }))

    expect(outcome.summarized).toBe(1)
    expect(writtenPaths()).toEqual([PUBLIC])
    expect(readNoteLocal).not.toHaveBeenCalledWith(PRIVATE, 1)
    const cloudTarget = vi.mocked(languageModelFor).mock.calls[0]![0]
    expect(cloudTarget).toMatchObject({
      kind: 'cloud',
      config: { provider: 'anthropic', model: 'claude-haiku-4-5' },
    })
  })

  it('never overwrites an aiSummary key of another shape', async () => {
    const foreign = upsertFrontmatter(LONG_BODY, { aiSummary: 'my own summary' })
    database.exec('DELETE FROM notes')
    addNote(PUBLIC, foreign)

    const outcome = await reconcileNoteSummaries(input())
    expect(writeNoteKeepingModified).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)
    expect(outcome.settled).toEqual([noteSummaryKey(PUBLIC, `hash-${PUBLIC}`)])

    const again = await reconcileNoteSummaries(input({ settled: new Set(outcome.settled) }))
    expect(again.pending).toBe(0)
  })

  it('defers a note with unsaved edits and does nothing when off', async () => {
    const outcome = await reconcileNoteSummaries(
      input({ isBusy: (path) => path === PUBLIC || path === PRIVATE }),
    )
    expect(writeNoteKeepingModified).not.toHaveBeenCalled()
    expect(outcome.nextDueAt).toBe(NOW - 1_000 + SUMMARY_QUIET_MS)

    const off = await reconcileNoteSummaries(input({ mode: 'off' }))
    expect(off.pending).toBe(0)
    expect(readNoteLocal).not.toHaveBeenCalled()
  })

  it('keeps the edit when the note changed while it was being summarized', async () => {
    vi.mocked(writeNoteKeepingModified).mockRejectedValue(
      Object.assign(new Error('changed on disk'), { kind: 'io' }),
    )
    const outcome = await reconcileNoteSummaries(input())
    expect(outcome.stopped).toBeNull()
    expect(outcome.summarized).toBe(0)
    expect(outcome.settled).toHaveLength(2)
  })
})
