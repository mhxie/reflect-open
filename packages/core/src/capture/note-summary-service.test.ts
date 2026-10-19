import { describe, expect, it, vi } from 'vitest'
import { MockLanguageModelV4 } from '@reflect/modules/ai/test'
import type { LanguageModelV4CallOptions, LanguageModelV4Usage } from '@ai-sdk/provider'
import { aiKeySecretName, createAiCredentialService } from '../ai/ai-credential-service.ts'
import { createAiProviderConfigService } from '../ai/ai-provider-config-service.ts'
import type { AiProvidersState } from '../ai/provider-config.ts'
import { createOpenDocumentsService } from '../documents/open-documents-service.ts'
import { AppError } from '../errors.ts'
import type { GraphRole } from '../graph/graph-session.ts'
import { project } from '../indexing/flow-test-harness.ts'
import type { IndexedNote } from '../indexing/indexed-note.ts'
import { noteBodyHash, parseNote, splitFrontmatter, upsertFrontmatter } from '../markdown/index.ts'
import { createBackgroundReconcilerFactory } from '../reconcile/background-reconciler.ts'
import type {
  AiProviderConfig,
  AiSummariesModel,
  OpenAiCompatibleProviderConfig,
  Settings,
} from '../settings/schema.ts'
import {
  createNodeTestDatabaseService,
  createTestActivityPort,
  createTestAiKeyValidationService,
  createTestClockService,
  createTestFileChangeService,
  createTestGraphSessionService,
  createTestIdService,
  createTestIndexLifecycleService,
  createTestLanguageModelService,
  createTestLoggerService,
  createTestNoteFileService,
  createTestNoteSession,
  createTestOnDeviceModelService,
  createTestSecretStoreService,
  createTestSettingsService,
} from '../testing/index.ts'
import {
  createNoteSummaryService,
  noteSummaryKey,
  SUMMARY_QUIET_MS,
  type NoteSummaryConsent,
  type NoteSummarySessionOptions,
  type ReconcileNoteSummariesInput,
  type ReconcileNoteSummariesOutcome,
} from './note-summary-service.ts'

const USAGE: LanguageModelV4Usage = {
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

/**
 * The cloud choice a confirmed go-ahead pinned: the provider's small model.
 */
const CLOUD_HAIKU = { configId: CLOUD.id, modelId: 'claude-haiku-4-5' }

const NOW = 2_000_000_000_000
const SETTLED_MTIME = NOW - 2 * SUMMARY_QUIET_MS
const LONG_BODY = `# Long\n\n${'A sentence that keeps the note going. '.repeat(30)}\n`

const PUBLIC = 'notes/public.md'
const PRIVATE = 'notes/private.md'
const SHORT = 'notes/short.md'
const RECENT = 'notes/recent.md'

const GENERATION = 1
const INDEX_GENERATION = 6

interface SetupOptions {
  /**
   * Seed the four default notes (two long settled ones, a short one, a recent one).
   */
  seed?: boolean
  localOnlyFolders?: string[]
  role?: GraphRole
  settings?: Partial<Settings>
}

/**
 * The summary service over an in-memory index and graph. The model answers
 * `Summary from on-device.` or `Summary from cloud.`, and every model call is
 * recorded in `calls`.
 */
async function setup(options: SetupOptions = {}) {
  const database = createNodeTestDatabaseService()
  const noteFile = createTestNoteFileService({ generation: GENERATION })
  const graphSession = createTestGraphSessionService({
    graph: {
      generation: GENERATION,
      indexGeneration: INDEX_GENERATION,
      localOnlyFolders: options.localOnlyFolders ?? [],
    },
  })
  const clock = createTestClockService({ now: NOW })
  const calls: LanguageModelV4CallOptions[] = []
  const languageModel = createTestLanguageModelService((config) => {
    return new MockLanguageModelV4({
      doGenerate: (callOptions) => {
        calls.push(callOptions)
        const engine = 'onDevice' in config && config.onDevice !== undefined ? 'on-device' : 'cloud'
        return Promise.resolve({
          content: [{ type: 'text', text: `Summary from ${engine}.` }],
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage: USAGE,
          warnings: [],
        })
      },
    })
  })
  const onDeviceModels = createTestOnDeviceModelService()
  const aiCredentials = createAiCredentialService({
    secretStore: createTestSecretStoreService({
      [aiKeySecretName(CLOUD.id)]: 'sk-cloud',
      [aiKeySecretName('work')]: 'sk-work',
    }),
  })
  const settings = createTestSettingsService({
    aiProviders: [LOCAL, CLOUD],
    defaultAiProviderId: CLOUD.id,
    aiSummaries: 'local',
    aiSummariesLocalModel: null,
    aiSummariesCloudModel: CLOUD_HAIKU,
    aiSummariesCloudConsent: CLOUD_HAIKU,
    ...options.settings,
  })
  await settings.whenLoaded()
  const indexLifecycle = createTestIndexLifecycleService({ database })
  const openDocuments = createOpenDocumentsService({ fileChanges: createTestFileChangeService() })
  const service = createNoteSummaryService({
    database,
    noteFile,
    indexLifecycle,
    openDocuments,
    aiProviderConfig: createAiProviderConfigService({
      settings,
      credentials: aiCredentials,
      keyValidation: createTestAiKeyValidationService(),
      id: createTestIdService(),
    }),
    aiCredentials,
    onDeviceModels,
    languageModel,
    settings,
    reconcilers: createBackgroundReconcilerFactory({ activity: createTestActivityPort() }),
    clock,
    role: options.role ?? 'main',
    graphSession,
    logger: createTestLoggerService(),
  })

  /**
   * Put a note into the graph and its projection (patched) into the index.
   */
  function addNote(
    path: string,
    source: string,
    mtime = SETTLED_MTIME,
    patch: Partial<IndexedNote> = {},
  ): void {
    noteFile.set(path, source)
    database.applyProjection({ ...project(path, source, mtime), ...patch })
  }

  if (options.seed !== false) {
    addNote(PUBLIC, LONG_BODY)
    addNote(PRIVATE, `---\nprivate: true\n---\n${LONG_BODY}`)
    addNote(SHORT, '# Short\n\nA few words.\n')
    addNote(RECENT, LONG_BODY, NOW - 1_000)
  }
  // The double's own checked write, for a test that stages a race around it.
  const writeThrough = noteFile.writeKeepingModified.bind(noteFile)
  const readLocal = vi.spyOn(noteFile, 'readLocal')
  const writeKeepingModified = vi.spyOn(noteFile, 'writeKeepingModified')

  return {
    service,
    database,
    graphSession,
    noteFile,
    settings,
    clock,
    indexLifecycle,
    openDocuments,
    onDeviceModels,
    languageModel,
    calls,
    addNote,
    readLocal,
    writeKeepingModified,
    writeThrough,
    readPaths: () => readLocal.mock.calls.map(([path]) => path),
    writtenPaths: () => writeKeepingModified.mock.calls.map(([path]) => path),
    configs: () => languageModel.calls().map((call) => call.config),
  }
}

function input(overrides: Partial<ReconcileNoteSummariesInput> = {}): ReconcileNoteSummariesInput {
  return {
    providers: { providers: [LOCAL, CLOUD], defaultProviderId: CLOUD.id },
    mode: 'local',
    localModel: null,
    cloudModel: CLOUD_HAIKU,
    cloudConsent: CLOUD_HAIKU,
    generation: GENERATION,
    ...overrides,
  }
}

function outcome(
  overrides: Partial<ReconcileNoteSummariesOutcome> = {},
): ReconcileNoteSummariesOutcome {
  return {
    pending: 0,
    summarized: 0,
    settled: [],
    remaining: false,
    nextDueAt: null,
    stopped: null,
    consent: null,
    ...overrides,
  }
}

/**
 * Settle the promise chains a pass runs on.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('NoteSummaryService.reconcile', () => {
  it('summarizes long settled notes on-device, private ones included', async () => {
    const { service, noteFile, readLocal, writeKeepingModified, writtenPaths } = await setup()
    const sources = new Map(noteFile.files())

    const result = await service.reconcile(input())

    expect(result.stopped).toBeNull()
    expect(result.summarized).toBe(2)
    expect(writtenPaths().sort()).toEqual([PRIVATE, PUBLIC])
    expect(result.nextDueAt).toBe(NOW - 1_000 + SUMMARY_QUIET_MS)
    // An on-device read is not sharing: it never waits on the sharing pause.
    expect(readLocal).toHaveBeenCalledWith(PUBLIC, GENERATION, { sharing: false })

    const [path, written, generation, expected] = writeKeepingModified.mock.calls[0]!
    expect(generation).toBe(GENERATION)
    expect(expected).toBe(sources.get(path))
    const body = splitFrontmatter(written).body
    expect(body).toBe(splitFrontmatter(sources.get(path)!).body)
    expect(parseNote({ path, source: written }).frontmatter.aiSummary).toEqual({
      text: 'Summary from on-device.',
      hash: noteBodyHash(body),
      generatedAt: new Date(NOW).toISOString(),
    })
    expect(noteFile.files().get(path)).toBe(written)
  })

  it('catches up with other devices before its first model call', async () => {
    const { service, noteFile, writeKeepingModified, calls } = await setup()
    const order: string[] = []
    const body = splitFrontmatter(LONG_BODY).body
    // The pull lands another device's summary of the public note's body.
    const catchUp = vi.fn(() => {
      order.push('catch up')
      noteFile.set(
        PUBLIC,
        upsertFrontmatter(LONG_BODY, {
          aiSummary: { text: 'From the other Mac.', hash: noteBodyHash(body) },
        }),
      )
    })
    writeKeepingModified.mockImplementation((path) => {
      order.push(`write ${path}`)
      return Promise.resolve()
    })

    const result = await service.reconcile(input({ catchUp }))

    expect(catchUp).toHaveBeenCalledTimes(1)
    expect(order).toEqual(['catch up', `write ${PRIVATE}`])
    expect(result.summarized).toBe(1)
    expect(calls).toHaveLength(1)
  })

  it('never catches up for a pass that sends nothing', async () => {
    const { service, calls } = await setup()
    const catchUp = vi.fn()

    await service.reconcile(input({ catchUp, isBusy: () => true }))
    await service.reconcile(
      input({ catchUp, providers: { providers: [CLOUD], defaultProviderId: CLOUD.id } }),
    )
    await service.reconcile(input({ catchUp, mode: 'cloud', cloudConsent: null }))

    expect(catchUp).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)
  })

  it('stops before any model call when the pass went stale while catching up', async () => {
    const { service, writeKeepingModified, calls } = await setup()
    let stale = false

    const result = await service.reconcile(
      input({
        isStale: () => stale,
        catchUp: () => {
          stale = true
        },
      }),
    )

    expect(result.stopped?.reason).toBe('stale')
    expect(calls).toHaveLength(0)
    expect(writeKeepingModified).not.toHaveBeenCalled()
  })

  it('puts off a note opened for editing while the pass caught up', async () => {
    const { service, addNote, readPaths, writtenPaths, calls } = await setup({ seed: false })
    addNote(PUBLIC, LONG_BODY)
    addNote(PRIVATE, `---\nprivate: true\n---\n${LONG_BODY}`)
    let editing = false
    // The private note, first in line, is opened and typed in meanwhile.
    const catchUp = vi.fn(() => {
      editing = true
    })

    const result = await service.reconcile(
      input({ catchUp, isBusy: (path) => editing && path === PRIVATE }),
    )

    expect(catchUp).toHaveBeenCalledTimes(1)
    expect(readPaths()).not.toContain(PRIVATE)
    expect(writtenPaths()).toEqual([PUBLIC])
    expect(calls).toHaveLength(1)
    expect(result.nextDueAt).toBe(NOW + SUMMARY_QUIET_MS)
  })

  it('goes on without other devices once catching up takes 30 seconds', async () => {
    const { service, clock, calls } = await setup()
    const asked = Promise.withResolvers<void>()
    const unanswered = Promise.withResolvers<void>()

    const pass = service.reconcile(
      input({
        catchUp: () => {
          asked.resolve()
          return unanswered.promise // a remote that never answers
        },
      }),
    )
    await asked.promise
    await flush()
    expect(calls).toHaveLength(0)
    await clock.advance(30_000)
    const result = await pass

    expect(result.stopped).toBeNull()
    expect(result.summarized).toBe(2)
    expect(calls).toHaveLength(2)
  })

  it('summarizes as it would offline when catching up fails', async () => {
    const { service, calls } = await setup()

    const result = await service.reconcile(
      input({ catchUp: () => Promise.reject(new AppError('network', 'offline')) }),
    )

    expect(result.stopped).toBeNull()
    expect(result.summarized).toBe(2)
    expect(calls).toHaveLength(2)
  })

  it('stops without a usable on-device model in local mode', async () => {
    const { service, writeKeepingModified, calls } = await setup()

    const result = await service.reconcile(
      input({ providers: { providers: [CLOUD], defaultProviderId: CLOUD.id } }),
    )

    expect(result.stopped?.reason).toBe('config')
    expect(writeKeepingModified).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)
  })

  it('stops when the on-device server fails its check, never falling back to cloud', async () => {
    const { service, onDeviceModels, writeKeepingModified, configs } = await setup()
    onDeviceModels.setVerdict({ kind: 'refused', reason: 'the model runs in the cloud' })

    const result = await service.reconcile(input())

    expect(result.stopped?.reason).toBe('config')
    expect(writeKeepingModified).not.toHaveBeenCalled()
    expect(configs()).toEqual([])
  })

  it('summarizes with the on-device model chosen for summaries', async () => {
    const { service, configs } = await setup()
    const gemma: OpenAiCompatibleProviderConfig = {
      ...LOCAL,
      id: 'gemma',
      model: 'gemma4:31b',
      onDevice: { model: 'gemma4:31b', baseUrl: LOCAL.baseUrl, server: 'ollama' },
    }
    const providers = { providers: [LOCAL, gemma, CLOUD], defaultProviderId: CLOUD.id }

    const result = await service.reconcile(
      input({ providers, localModel: { configId: 'gemma', modelId: 'gemma4:31b' } }),
    )
    expect(result.summarized).toBe(2)
    expect(configs()).toEqual([expect.objectContaining({ id: 'gemma', model: 'gemma4:31b' })])

    // A choice whose entry no longer runs that model stops instead of falling back.
    const stale = await service.reconcile(
      input({ providers, localModel: { configId: 'gemma', modelId: 'gemma4:26b' } }),
    )
    expect(stale.stopped).toEqual({
      reason: 'config',
      message: 'The model chosen for note summaries no longer runs on this Mac.',
    })
    expect(configs()).toHaveLength(1)
  })

  it('summarizes public notes only with the cloud small model in cloud mode', async () => {
    const { service, readLocal, readPaths, writtenPaths, onDeviceModels, configs } = await setup()

    const result = await service.reconcile(input({ mode: 'cloud' }))

    expect(result.summarized).toBe(1)
    expect(writtenPaths()).toEqual([PUBLIC])
    // The private note is never read, and the read bound for the cloud
    // refuses while sharing is paused.
    expect(readPaths()).toEqual([PUBLIC])
    expect(readLocal).toHaveBeenCalledWith(PUBLIC, GENERATION, { sharing: true })
    // The configured on-device model is `local` mode's: cloud mode never probes it.
    expect(onDeviceModels.verifyCalls()).toEqual([])
    expect(configs()).toEqual([
      expect.objectContaining({ provider: 'anthropic', model: 'claude-haiku-4-5' }),
    ])
  })

  it('asks before the first cloud note leaves, counting from the index alone', async () => {
    const { service, readLocal, writeKeepingModified, calls } = await setup()

    const asked = await service.reconcile(input({ mode: 'cloud', cloudConsent: null }))

    // PUBLIC and RECENT wait; the private note is not counted.
    expect(asked.consent).toEqual({ notes: 2, provider: 'anthropic', choice: CLOUD_HAIKU })
    expect(asked.stopped).toBeNull()
    expect(readLocal).not.toHaveBeenCalled()
    expect(writeKeepingModified).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)

    // On this Mac sends nothing, so it needs no go-ahead.
    const local = await service.reconcile(input({ cloudConsent: null }))
    expect(local.consent).toBeNull()
    expect(local.summarized).toBe(2)
  })

  it('asks whenever the model it would use is not exactly the one agreed to', async () => {
    const { service, readLocal, calls } = await setup()
    const sonnet = { configId: CLOUD.id, modelId: 'claude-sonnet-5-5' }
    const work: AiProviderConfig = { ...CLOUD, id: 'work' }
    const cases: [Partial<ReconcileNoteSummariesInput>, AiSummariesModel][] = [
      // Nothing agreed: the default provider's small model is named.
      [{ cloudModel: null, cloudConsent: null }, CLOUD_HAIKU],
      // Another model on the agreed entry.
      [{ cloudModel: sonnet, cloudConsent: CLOUD_HAIKU }, sonnet],
      // The agreed model on another entry.
      [
        {
          providers: { providers: [CLOUD, work], defaultProviderId: CLOUD.id },
          cloudModel: { configId: 'work', modelId: 'claude-haiku-4-5' },
          cloudConsent: CLOUD_HAIKU,
        },
        { configId: 'work', modelId: 'claude-haiku-4-5' },
      ],
    ]
    for (const [overrides, named] of cases) {
      const asked = await service.reconcile(input({ mode: 'cloud', ...overrides }))
      expect(asked.consent).toEqual({ notes: 2, provider: 'anthropic', choice: named })
    }
    expect(readLocal).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)
  })

  it('summarizes with the cloud model chosen for summaries once agreed to', async () => {
    const { service, configs } = await setup()
    const chosen = { configId: CLOUD.id, modelId: 'claude-sonnet-5-5' }

    const result = await service.reconcile(
      input({ mode: 'cloud', cloudModel: chosen, cloudConsent: chosen }),
    )

    expect(result.summarized).toBe(1)
    expect(configs()).toEqual([
      expect.objectContaining({ id: CLOUD.id, model: 'claude-sonnet-5-5' }),
    ])
  })

  it('never reads device-only or local-only notes in cloud mode', async () => {
    const { service, addNote, readPaths } = await setup({ localOnlyFolders: ['vault'] })
    // Pin each exclusion to its own mechanism, not the private flag.
    addNote('notes/device-only.md', LONG_BODY, SETTLED_MTIME, { hasDeviceOnlyContent: true })
    addNote('vault/local-only.md', LONG_BODY, SETTLED_MTIME, { isPrivate: false })

    const asked = await service.reconcile(input({ mode: 'cloud', cloudConsent: null }))
    expect(asked.consent?.notes).toBe(2)
    const result = await service.reconcile(input({ mode: 'cloud' }))
    expect(result.summarized).toBe(1)
    expect(readPaths()).toEqual([PUBLIC])
  })

  it('never summarizes a local-only note, even on-device', async () => {
    const { service, addNote, readPaths, writtenPaths } = await setup({
      seed: false,
      localOnlyFolders: ['vault'],
    })
    addNote('vault/local-only.md', LONG_BODY)

    const result = await service.reconcile(input())

    expect(result.pending).toBe(0)
    expect(readPaths()).toEqual([])
    expect(writtenPaths()).toEqual([])
  })

  it('stops in cloud mode without a cloud provider', async () => {
    const { service, onDeviceModels, writeKeepingModified, calls } = await setup()
    const cases: [AiProvidersState, AiSummariesModel | null, RegExp][] = [
      [{ providers: [LOCAL], defaultProviderId: LOCAL.id }, null, /choose On this Mac/],
      // A cloud entry behind an on-device default is not picked silently.
      [{ providers: [LOCAL, CLOUD], defaultProviderId: LOCAL.id }, null, /choose On this Mac/],
      [{ providers: [], defaultProviderId: null }, null, /No AI provider/],
      // A chosen entry that was removed is not replaced by another.
      [{ providers: [LOCAL], defaultProviderId: LOCAL.id }, CLOUD_HAIKU, /was removed/],
      [
        { providers: [LOCAL, CLOUD], defaultProviderId: CLOUD.id },
        { configId: LOCAL.id, modelId: LOCAL.model },
        /runs on this Mac/,
      ],
    ]
    for (const [providers, cloudModel, message] of cases) {
      const result = await service.reconcile(input({ mode: 'cloud', providers, cloudModel }))
      expect(result.stopped).toEqual({
        reason: 'config',
        message: expect.stringMatching(message) as string,
      })
    }
    expect(onDeviceModels.verifyCalls()).toEqual([])
    expect(writeKeepingModified).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)
  })

  it('never overwrites an aiSummary key of another shape', async () => {
    const { service, addNote, writeKeepingModified, calls } = await setup({ seed: false })
    addNote(PUBLIC, upsertFrontmatter(LONG_BODY, { aiSummary: 'my own summary' }))

    const result = await service.reconcile(input())

    expect(writeKeepingModified).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)
    expect(result.settled).toEqual([noteSummaryKey(PUBLIC, `hash-${PUBLIC}`)])

    const again = await service.reconcile(input({ settled: new Set(result.settled) }))
    expect(again.pending).toBe(0)
  })

  it('asks the index to re-read a note whose summary it never saw', async () => {
    const { service, noteFile, indexLifecycle, writtenPaths } = await setup()
    // An earlier build wrote the block under the note's kept mtime and the
    // index skipped that write: the file is summarized, its row still stale.
    const body = splitFrontmatter(LONG_BODY).body
    noteFile.set(
      PUBLIC,
      upsertFrontmatter(LONG_BODY, {
        aiSummary: { text: 'Written before.', hash: noteBodyHash(body) },
      }),
    )
    const requestReread = vi.spyOn(indexLifecycle, 'requestReread')

    // At launch the live index subscribes only after its first reconcile: a
    // request nobody took leaves the note for a later pass, not settled.
    requestReread.mockReturnValue(false)
    const early = await service.reconcile(input())
    expect(early.settled).not.toContain(noteSummaryKey(PUBLIC, `hash-${PUBLIC}`))

    requestReread.mockReturnValue(true)
    const result = await service.reconcile(input())

    // Only the index looks again, at the time it holds: no write is made,
    // so sync and iCloud never take this for one of this device's writes.
    expect(requestReread).toHaveBeenLastCalledWith([PUBLIC])
    expect(writtenPaths()).not.toContain(PUBLIC)
    expect(result.settled).toContain(noteSummaryKey(PUBLIC, `hash-${PUBLIC}`))
  })

  it('defers a note with unsaved edits and does nothing when off', async () => {
    const { service, readLocal, writeKeepingModified } = await setup()

    const result = await service.reconcile(
      input({ isBusy: (path) => path === PUBLIC || path === PRIVATE }),
    )
    expect(writeKeepingModified).not.toHaveBeenCalled()
    expect(result.nextDueAt).toBe(NOW - 1_000 + SUMMARY_QUIET_MS)

    readLocal.mockClear()
    const off = await service.reconcile(input({ mode: 'off' }))
    expect(off.pending).toBe(0)
    expect(readLocal).not.toHaveBeenCalled()
  })

  it('keeps the edit when the note changed while it was being summarized', async () => {
    const { service, noteFile, writeKeepingModified, writeThrough } = await setup()
    // An edit lands between the read and the checked write.
    writeKeepingModified.mockImplementation(async (path, contents, generation, expected) => {
      noteFile.set(path, `${expected}\nTyped meanwhile.\n`)
      await writeThrough(path, contents, generation, expected)
    })

    const result = await service.reconcile(input())

    expect(result.stopped).toBeNull()
    expect(result.summarized).toBe(0)
    expect(result.settled).toHaveLength(2)
    expect(noteFile.files().get(PUBLIC)).toBe(`${LONG_BODY}\nTyped meanwhile.\n`)
  })

  it('a pass for a graph that is no longer open reads nothing', async () => {
    const { service, readLocal } = await setup()

    const result = await service.reconcile(input({ generation: GENERATION + 1 }))

    expect(result.stopped?.reason).toBe('stale')
    expect(readLocal).not.toHaveBeenCalled()
  })

  it('reports a failed write as stopped, never throwing', async () => {
    const { service, writeKeepingModified } = await setup()
    writeKeepingModified.mockRejectedValue(new AppError('unsupported', 'refused'))

    const result = await service.reconcile(input())

    expect(result.stopped).toEqual({ reason: 'unsupported', message: 'refused' })
  })
})

describe('NoteSummaryService.openSession', () => {
  const NOTE_CHANGE = [{ path: 'notes/a.md', kind: 'upsert' as const, modifiedMs: 1 }]

  async function openSession(
    options: SetupOptions = {},
    sessionOptions: Pick<NoteSummarySessionOptions, 'catchUp'> = {},
  ) {
    const kit = await setup({ seed: false, ...options })
    const reconcile = vi.spyOn(kit.service, 'reconcile').mockResolvedValue(outcome())
    const onConsentNeeded = vi.fn<(consent: NoteSummaryConsent) => void>()
    const session = kit.service.openSession({ onConsentNeeded, ...sessionOptions })
    return { ...kit, reconcile, onConsentNeeded, session }
  }

  it('hands every pass the catch-up with other devices', async () => {
    const catchUp = vi.fn()
    const { session, reconcile, indexLifecycle } = await openSession({}, { catchUp })
    session.start()
    await flush()
    indexLifecycle.emitApplied(NOTE_CHANGE, INDEX_GENERATION)
    await flush()

    // Other devices' summaries arrive through the backup's pull.
    expect(reconcile.mock.calls.map(([passInput]) => passInput.catchUp)).toEqual([catchUp, catchUp])
  })

  it('catches up once per burst: a backlog goes on without catching up again', async () => {
    const catchUp = vi.fn()
    const { session, reconcile, indexLifecycle } = await openSession({}, { catchUp })
    reconcile.mockResolvedValueOnce(outcome({ remaining: true }))
    session.start()
    await flush()
    indexLifecycle.emitApplied(NOTE_CHANGE, INDEX_GENERATION)
    await flush()

    // The launch pass, its continuation, then the pass after a note change.
    expect(reconcile.mock.calls.map(([passInput]) => passInput.catchUp)).toEqual([
      catchUp,
      undefined,
      catchUp,
    ])
  })

  it('throws when no graph is open', async () => {
    const { service, graphSession } = await setup({ seed: false })
    graphSession.setGraph(null)

    expect(() => service.openSession({ onConsentNeeded: () => {} })).toThrow('No graph is open.')
  })

  it('runs a launch pass and a pass after each indexed note change', async () => {
    const { session, reconcile, indexLifecycle } = await openSession()
    session.start()
    await flush()
    expect(reconcile).toHaveBeenCalledTimes(1)
    expect(reconcile.mock.calls[0]![0]).toMatchObject({
      generation: GENERATION,
      mode: 'local',
      localModel: null,
      cloudModel: CLOUD_HAIKU,
      cloudConsent: CLOUD_HAIKU,
    })

    indexLifecycle.emitApplied(NOTE_CHANGE, INDEX_GENERATION)
    await flush()
    expect(reconcile).toHaveBeenCalledTimes(2)

    // Another index session's change, and an asset change, are not notes to summarize.
    indexLifecycle.emitApplied(NOTE_CHANGE, INDEX_GENERATION + 1)
    indexLifecycle.emitApplied(
      [{ path: 'assets/a.png', kind: 'upsert', modifiedMs: 1 }],
      INDEX_GENERATION,
    )
    await flush()
    expect(reconcile).toHaveBeenCalledTimes(2)

    // A committed sync pass names no files: any row may have changed.
    indexLifecycle.emitApplied(null, INDEX_GENERATION)
    await flush()
    expect(reconcile).toHaveBeenCalledTimes(3)
  })

  it('skips a note with unsaved edits in an open editor', async () => {
    const { session, reconcile, openDocuments } = await openSession()
    openDocuments.register({
      session: createTestNoteSession({ path: PUBLIC, dirty: true, generation: GENERATION }),
    })
    session.start()
    await flush()

    const isBusy = reconcile.mock.calls[0]![0].isBusy
    expect(isBusy?.(PUBLIC)).toBe(true)
    expect(isBusy?.(PRIVATE)).toBe(false)
  })

  it('passes settled notes back to later passes', async () => {
    const { session, reconcile, indexLifecycle } = await openSession()
    reconcile.mockResolvedValueOnce(outcome({ settled: ['h:notes/a.md'] }))
    session.start()
    await flush()

    indexLifecycle.emitApplied(NOTE_CHANGE, INDEX_GENERATION)
    await flush()

    expect([...(reconcile.mock.calls[1]![0].settled ?? [])]).toEqual(['h:notes/a.md'])
  })

  it('keeps going while a batch remains and wakes when a quiet period ends', async () => {
    const { session, reconcile, clock } = await openSession()
    reconcile
      .mockResolvedValueOnce(outcome({ remaining: true }))
      .mockResolvedValueOnce(outcome({ nextDueAt: NOW + 60_000 }))
    session.start()
    await flush()
    expect(reconcile).toHaveBeenCalledTimes(2)

    await clock.advance(60_000)
    await flush()
    expect(reconcile).toHaveBeenCalledTimes(3)
  })

  it('backs off after a missing model until the summary settings change', async () => {
    const { session, reconcile, indexLifecycle, settings, clock } = await openSession()
    const noModel = outcome({ stopped: { reason: 'config', message: 'no model' } })
    reconcile.mockResolvedValueOnce(noModel)
    session.start()
    await flush()

    // Saves don't re-probe a local server that isn't running.
    indexLifecycle.emitApplied(NOTE_CHANGE, INDEX_GENERATION)
    await flush()
    expect(reconcile).toHaveBeenCalledTimes(1)

    // Choosing a model runs a pass at once, with that model.
    const gemma = { configId: 'gemma', modelId: 'gemma4:31b' }
    reconcile.mockResolvedValueOnce(noModel)
    settings.update({ aiSummariesLocalModel: gemma })
    await flush()
    expect(reconcile).toHaveBeenCalledTimes(2)
    expect(reconcile.mock.calls[1]![0]).toMatchObject({ localModel: gemma })

    // The back-off lapses after ten minutes.
    indexLifecycle.emitApplied(NOTE_CHANGE, INDEX_GENERATION)
    await flush()
    expect(reconcile).toHaveBeenCalledTimes(2)
    await clock.advance(10 * 60_000)
    indexLifecycle.emitApplied(NOTE_CHANGE, INDEX_GENERATION)
    await flush()
    expect(reconcile).toHaveBeenCalledTimes(3)
  })

  it('a settings change before start runs nothing', async () => {
    const { session, reconcile, settings } = await openSession()

    settings.update({ aiSummariesLocalModel: { configId: 'gemma', modelId: 'gemma4:31b' } })
    await flush()
    expect(reconcile).not.toHaveBeenCalled()

    session.start()
    await flush()
    expect(reconcile).toHaveBeenCalledTimes(1)
  })

  it('does nothing while summaries are off', async () => {
    const { session, reconcile, indexLifecycle } = await openSession({
      settings: { aiSummaries: 'off' },
    })
    session.start()
    indexLifecycle.emitApplied(NOTE_CHANGE, INDEX_GENERATION)
    await flush()

    expect(reconcile).not.toHaveBeenCalled()
  })

  it('does nothing in a note window: two summarizers would race the writes', async () => {
    const { session, reconcile } = await openSession({ role: 'note-window' })
    session.start()
    await flush()

    expect(reconcile).not.toHaveBeenCalled()
  })

  it('asks once per model while a cloud pass waits for the go-ahead', async () => {
    const { session, reconcile, indexLifecycle, settings, onConsentNeeded } = await openSession({
      settings: { aiSummaries: 'cloud', aiSummariesCloudConsent: null },
    })
    const consent: NoteSummaryConsent = {
      notes: 12,
      provider: 'openai',
      choice: { configId: 'work', modelId: 'gpt-5.4-nano' },
    }
    reconcile.mockResolvedValue(outcome({ pending: 12, consent }))
    session.start()
    await flush()
    expect(reconcile.mock.calls[0]![0]).toMatchObject({ mode: 'cloud', cloudConsent: null })
    expect(onConsentNeeded).toHaveBeenCalledWith(consent)

    indexLifecycle.emitApplied(NOTE_CHANGE, INDEX_GENERATION)
    await flush()
    expect(reconcile).toHaveBeenCalledTimes(2)
    expect(onConsentNeeded).toHaveBeenCalledTimes(1)

    // Another model, even on the same entry, asks again, naming it.
    const mini = { ...consent, choice: { configId: 'work', modelId: 'gpt-5.4-mini' } }
    reconcile.mockResolvedValue(outcome({ pending: 12, consent: mini }))
    indexLifecycle.emitApplied(NOTE_CHANGE, INDEX_GENERATION)
    await flush()
    expect(onConsentNeeded).toHaveBeenLastCalledWith(mini)
    expect(onConsentNeeded).toHaveBeenCalledTimes(2)

    // A summary setting changed: the app withdrew the open ask, so the same
    // model is asked about again rather than left waiting in silence.
    settings.update({ aiSummariesLocalModel: { configId: 'gemma', modelId: 'gemma4:31b' } })
    await flush()
    expect(onConsentNeeded).toHaveBeenCalledTimes(3)
    expect(onConsentNeeded).toHaveBeenLastCalledWith(mini)
  })

  it('a new go-ahead starts over: notes settled for another engine are tried again', async () => {
    const { session, reconcile, settings } = await openSession({
      settings: { aiSummaries: 'cloud' },
    })
    reconcile.mockResolvedValueOnce(outcome({ settled: ['h:notes/a.md'] }))
    session.start()
    await flush()

    const sonnet = { configId: CLOUD.id, modelId: 'claude-sonnet-5-5' }
    settings.update({ aiSummariesCloudModel: sonnet, aiSummariesCloudConsent: sonnet })
    await flush()

    expect(reconcile).toHaveBeenCalledTimes(2)
    expect(reconcile.mock.calls[1]![0]).toMatchObject({ cloudModel: sonnet, cloudConsent: sonnet })
    expect([...(reconcile.mock.calls[1]![0].settled ?? [])]).toEqual([])
  })

  it('dispose stops the triggers and the quiet-period timer', async () => {
    const { session, reconcile, indexLifecycle, clock } = await openSession()
    reconcile.mockResolvedValueOnce(outcome({ nextDueAt: NOW + 60_000 }))
    session.start()
    await flush()
    expect(clock.pendingTimers()).toBe(1)

    session.dispose()
    indexLifecycle.emitApplied(NOTE_CHANGE, INDEX_GENERATION)
    await clock.advance(60_000)
    await flush()

    expect(clock.pendingTimers()).toBe(0)
    expect(reconcile).toHaveBeenCalledTimes(1)
  })
})
