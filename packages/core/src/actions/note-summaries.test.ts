import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { MockLanguageModelV3 } from '@reflect/modules/ai/test'
import type { LanguageModelV3CallOptions, LanguageModelV3Usage } from '@ai-sdk/provider'
import { languageModelFor } from '../ai/language-model.ts'
import type { AiProvidersState } from '../ai/provider-config.ts'
import { aiApiKeyForConfig } from '../ai/secrets.ts'
import { readNoteLocal, writeNoteKeepingModified } from '../graph/commands.ts'
import { setLocalOnlyFolders } from '../graph/local-only.ts'
import {
  applyProjection,
  connectIndex,
  openMigratedIndex,
  project,
} from '../indexing/flow-test-harness.ts'
import { echoLocalWrite } from '../indexing/local-write-echo.ts'
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
vi.mock('../indexing/local-write-echo', async (original) => ({
  ...(await original<typeof import('../indexing/local-write-echo.ts')>()),
  echoLocalWrite: vi.fn(),
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
    cloudConfirmed: true,
    generation: 1,
    now: () => NOW,
    ...overrides,
  }
}

function writtenPaths(): string[] {
  return vi.mocked(writeNoteKeepingModified).mock.calls.map(([path]) => path)
}

function readPaths(): string[] {
  return vi.mocked(readNoteLocal).mock.calls.map(([path]) => path)
}

afterEach(() => {
  setLocalOnlyFolders([])
})

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
    // An on-device read is not sharing: it never waits on the sharing pause.
    expect(readNoteLocal).toHaveBeenCalledWith(PUBLIC, 1, { sharing: false })

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

  it('summarizes public notes only with the cloud small model in cloud mode', async () => {
    const outcome = await reconcileNoteSummaries(input({ mode: 'cloud' }))

    expect(outcome.summarized).toBe(1)
    expect(writtenPaths()).toEqual([PUBLIC])
    // The private note is never read, and the read bound for the cloud
    // refuses while sharing is paused.
    expect(readPaths()).toEqual([PUBLIC])
    expect(readNoteLocal).toHaveBeenCalledWith(PUBLIC, 1, { sharing: true })
    // The configured on-device model is `local` mode's: cloud mode never probes it.
    expect(verifyOnDeviceServer).not.toHaveBeenCalled()
    expect(vi.mocked(languageModelFor).mock.calls.map(([target]) => target)).toEqual([
      expect.objectContaining({
        kind: 'cloud',
        config: expect.objectContaining({ provider: 'anthropic', model: 'claude-haiku-4-5' }),
      }),
    ])
  })

  it('asks before the first cloud note leaves, counting from the index alone', async () => {
    const asked = await reconcileNoteSummaries(input({ mode: 'cloud', cloudConfirmed: false }))
    // PUBLIC and RECENT wait; the private note is not counted.
    expect(asked.consent).toEqual({ notes: 2, provider: 'anthropic' })
    expect(asked.stopped).toBeNull()
    expect(readNoteLocal).not.toHaveBeenCalled()
    expect(writeNoteKeepingModified).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)

    // On this Mac sends nothing, so it needs no go-ahead.
    const local = await reconcileNoteSummaries(input({ cloudConfirmed: false }))
    expect(local.consent).toBeNull()
    expect(local.summarized).toBe(2)
  })

  it('never reads device-only or local-only notes in cloud mode', async () => {
    const deviceOnly = 'notes/device-only.md'
    const localOnly = 'vault/local-only.md'
    addNote(deviceOnly, LONG_BODY)
    addNote(localOnly, LONG_BODY)
    // Pin each exclusion to its own mechanism, not the private flag.
    database.exec(`UPDATE notes SET has_device_only_content = 1 WHERE path = '${deviceOnly}'`)
    database.exec(`UPDATE notes SET is_private = 0 WHERE path = '${localOnly}'`)
    setLocalOnlyFolders(['vault'])

    const asked = await reconcileNoteSummaries(input({ mode: 'cloud', cloudConfirmed: false }))
    expect(asked.consent?.notes).toBe(2)
    const outcome = await reconcileNoteSummaries(input({ mode: 'cloud' }))
    expect(outcome.summarized).toBe(1)
    expect(readPaths()).toEqual([PUBLIC])
  })

  it('stops in cloud mode without a cloud provider', async () => {
    const cases: [AiProvidersState, RegExp][] = [
      [{ providers: [LOCAL], defaultProviderId: LOCAL.id }, /choose On this Mac/],
      // A cloud entry behind an on-device default is not picked silently.
      [{ providers: [LOCAL, CLOUD], defaultProviderId: LOCAL.id }, /choose On this Mac/],
      [{ providers: [], defaultProviderId: null }, /No AI provider/],
    ]
    for (const [providers, message] of cases) {
      const outcome = await reconcileNoteSummaries(input({ mode: 'cloud', providers }))
      expect(outcome.stopped).toEqual({ reason: 'config', message: expect.stringMatching(message) })
    }
    expect(verifyOnDeviceServer).not.toHaveBeenCalled()
    expect(writeNoteKeepingModified).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)
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

  it('asks the index to re-read a note whose summary it never saw', async () => {
    // An earlier build wrote the block under the note's kept mtime and the
    // index skipped that write: the file is summarized, its row still stale.
    const body = splitFrontmatter(LONG_BODY).body
    files.set(
      PUBLIC,
      upsertFrontmatter(LONG_BODY, {
        aiSummary: { text: 'Written before.', hash: noteBodyHash(body) },
      }),
    )

    const outcome = await reconcileNoteSummaries(input())

    expect(writtenPaths()).toEqual([PRIVATE])
    expect(echoLocalWrite).toHaveBeenCalledExactlyOnceWith({
      path: PUBLIC,
      kind: 'upsert',
      modifiedMs: SETTLED_MTIME,
      reread: true,
    })
    expect(outcome.settled).toEqual([noteSummaryKey(PUBLIC, `hash-${PUBLIC}`)])
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
