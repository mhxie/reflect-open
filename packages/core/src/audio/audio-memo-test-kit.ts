import { vi, type Mock, type MockInstance } from 'vitest'
import { audioMemoIdentity } from './audio-memo.ts'
import { aiKeySecretName, createAiCredentialService } from '../ai/ai-credential-service.ts'
import { createAiProviderConfigService } from '../ai/ai-provider-config-service.ts'
import type { AiProvidersState } from '../ai/provider-config.ts'
import {
  createTranscriptEnrichmentService,
  type TranscriptEnrichmentService,
} from '../ai/transcript-enrichment-service.ts'
import type { LocalTranscriptionService } from '../ai/local-transcription-service.ts'
import { createBackgroundReconcilerFactory } from '../reconcile/background-reconciler.ts'
import {
  createBacklinkTargetService,
  type BacklinkTargetService,
} from '../capture/backlink-target-service.ts'
import { createMeetingService } from '../contacts/meeting-service.ts'
import { createPersonNoteService } from '../contacts/person-note-service.ts'
import type { AssetStoreService } from '../graph/asset-store-service.ts'
import type { GraphRole } from '../graph/graph-session.ts'
import type { GraphSessionService } from '../graph/graph-session-service.ts'
import { createSuggestionService } from '../indexing/suggestion-service.ts'
import { createWikiResolverService } from '../indexing/wiki-resolver-service.ts'
import type { ActivityPort } from '../ports/activity-port.ts'
import type { LoggerService } from '../ports/logger-service.ts'
import type { ProgressPort } from '../ports/progress-port.ts'
import { createRecorderService, type RecorderService } from '../recordings/recorder-service.ts'
import { createRecordingService, type RecordingService } from '../recordings/recording-service.ts'
import type { SecretStoreService } from '../secrets/secret-store-service.ts'
import type { SettingsService } from '../settings/settings-service.ts'
import {
  createTestAiKeyValidationService,
  createTestIdService,
  createTestAssetStoreService,
  createTestLanguageModelService,
  createTestCalendarService,
  createTestClockService,
  createTestContactsService,
  createTestDatabaseService,
  createTestFileChangeService,
  createTestActivityPort,
  createTestIpcBridgeService,
  createTestLocalTranscriptionService,
  createTestNoteCreationService,
  createTestNoteFileService,
  createTestPlatformService,
  createTestProgressPort,
  createTestSecretStoreService,
  createTestSettingsService,
  createTestTranscriptionService,
  type TestAssetStoreService,
  type TestClockService,
  type TestFileChangeService,
  type TestActivityPort,
  type TestIpcBridgeService,
  type TestLocalTranscriptionService,
  type TestNoteFileService,
  type TestProgressPort,
  type TestSecretStoreService,
  type TestSettingsService,
  type TestTranscriptionService,
} from '../testing/index.ts'
import {
  createAudioMemoTranscriptionService,
  type AudioMemoTranscriptionService,
  type ReconcileAudioMemosInput,
  type ReconcileAudioMemosOutcome,
} from './audio-memo-transcription-service.ts'

/**
 * Shared setup for the audio memo transcription tests: the transcription
 * service over one set of in-memory services, with a configured OpenAI entry
 * and its key unless overridden.
 */

export const OPENAI_CONFIG = {
  id: 'cfg-openai',
  provider: 'openai',
  model: 'gpt-5.1',
  keyHint: 'wxyz1',
} as const

export const ANTHROPIC_CONFIG = {
  id: 'cfg-anthropic',
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  keyHint: 'wxyz1',
} as const

export const PROVIDERS: AiProvidersState = {
  providers: [OPENAI_CONFIG],
  defaultProviderId: 'cfg-openai',
}
export const NO_PROVIDERS: AiProvidersState = { providers: [], defaultProviderId: null }

export const OPENAI_KEY = aiKeySecretName('cfg-openai')
export const ANTHROPIC_KEY = aiKeySecretName('cfg-anthropic')

/**
 * 2026-06-11 15:30:22.845 local — every derived name is asserted from it.
 */
export const RECORDED_AT = new Date(2026, 5, 11, 15, 30, 22, 845)
export const MEMO = audioMemoIdentity(RECORDED_AT, 'audio/webm;codecs=opus')
export const DAILY = 'daily/2026-06-11.md'

export interface AudioMemoTestKitOptions {
  providers?: AiProvidersState
}

export interface AudioMemoTestKit {
  /**
   * The in-memory graph: notes, and the listing of `audio-memos/`.
   */
  noteFile: TestNoteFileService
  /**
   * The recordings' bytes and the transcript cache.
   */
  assetStore: TestAssetStoreService
  secrets: TestSecretStoreService
  settings: TestSettingsService
  transcription: TestTranscriptionService
  /**
   * The on-device engine; its model is downloaded unless a test says otherwise.
   */
  localTranscription: TestLocalTranscriptionService
  progress: TestProgressPort
  activity: TestActivityPort
  fileChanges: TestFileChangeService
  clock: TestClockService
  getSecretMock: MockInstance<SecretStoreService['get']>
  readBytesMock: MockInstance<AssetStoreService['readBytes']>
  readTranscriptCacheMock: MockInstance<AssetStoreService['readTranscriptCache']>
  enrichMock: Mock<TranscriptEnrichmentService['enrich']>
  ensureBacklinkTargetMock: Mock<BacklinkTargetService['ensure']>
  service: AudioMemoTranscriptionService
  /**
   * Put a recording into `audio-memos/`, with the bytes `audio-bytes`.
   */
  addRecording(path: string, options?: { modifiedMs?: number }): void
  /**
   * Run one pass at generation 3 with the cloud engine, without formatting, a
   * hint or spoken languages unless overridden.
   */
  reconcile(overrides?: Partial<ReconcileAudioMemosInput>): Promise<ReconcileAudioMemosOutcome>
}

/**
 * Fresh in-memory services with the transcription service built on them.
 */
export async function createAudioMemoTestKit(
  options?: AudioMemoTestKitOptions,
): Promise<AudioMemoTestKit> {
  const providers = options?.providers ?? PROVIDERS
  const noteFile = createTestNoteFileService({ files: { [DAILY]: 'morning thoughts\n' } })
  const assets = new Map<string, string>()
  const assetStore = createTestAssetStoreService()
  const secrets = createTestSecretStoreService({
    [OPENAI_KEY]: 'sk-live-key',
    [ANTHROPIC_KEY]: 'sk-live-key',
  })
  const getSecretMock = vi.spyOn(secrets, 'get')
  const settings = createTestSettingsService({
    aiProviders: providers.providers,
    defaultAiProviderId: providers.defaultProviderId,
  })
  await settings.whenLoaded()
  const aiCredentials = createAiCredentialService({ secretStore: secrets })
  const transcription = createTestTranscriptionService('memo transcript')
  const localTranscription = createTestLocalTranscriptionService()
  const enrichMock = vi
    .fn<TranscriptEnrichmentService['enrich']>()
    .mockImplementation(async (input) => ({ title: 'Memo Transcript', body: input.transcript }))
  const transcriptEnrichment = createTranscriptEnrichmentService({
    languageModel: createTestLanguageModelService(),
  })
  vi.spyOn(transcriptEnrichment, 'enrich').mockImplementation(enrichMock)
  const ensureBacklinkTargetMock = vi
    .fn<BacklinkTargetService['ensure']>()
    .mockResolvedValue('Audio memos')
  const clock = createTestClockService({ now: Date.now() })
  const progress = createTestProgressPort()
  const activity = createTestActivityPort()
  const fileChanges = createTestFileChangeService()
  const readBytesMock = vi
    .spyOn(assetStore, 'readBytes')
    .mockImplementation(async (path) => new TextEncoder().encode(assets.get(path) ?? ''))

  const service = createAudioMemoTranscriptionService({
    noteFile,
    assetStore,
    backlinkTarget: { ensure: ensureBacklinkTargetMock },
    transcription,
    localTranscription,
    transcriptEnrichment,
    aiProviderConfig: createAiProviderConfigService({
      settings,
      credentials: aiCredentials,
      keyValidation: createTestAiKeyValidationService(),
      id: createTestIdService(),
    }),
    aiCredentials,
    settings,
    reconcilers: createBackgroundReconcilerFactory({ activity }),
    activity,
    fileChanges,
    progress,
    clock,
  })

  return {
    noteFile,
    assetStore,
    secrets,
    settings,
    transcription,
    localTranscription,
    progress,
    activity,
    fileChanges,
    clock,
    getSecretMock,
    readBytesMock,
    readTranscriptCacheMock: vi.spyOn(assetStore, 'readTranscriptCache'),
    enrichMock,
    ensureBacklinkTargetMock,
    service,
    addRecording(path, recordingOptions) {
      // One byte in the listing: an empty file is an end marker, never sent.
      noteFile.set(path, 'x', { modifiedMs: recordingOptions?.modifiedMs ?? 0 })
      assets.set(path, 'audio-bytes')
    },
    reconcile: (overrides = {}) =>
      service.reconcile({
        generation: 3,
        formatTranscript: false,
        transcriptionPrompt: '',
        engine: 'cloud',
        localModel: 'large-v3-turbo',
        transcriptionLanguages: [],
        ...overrides,
      }),
  }
}

export interface TestRecordingStackDeps {
  /**
   * The native recorder's commands. Off the native shell the recorder never
   * calls them and reads as unsupported.
   */
  readonly ipc?: TestIpcBridgeService
  /**
   * Whether the recorder runs in the native shell; off by default.
   */
  readonly nativeShell?: boolean
  readonly noteFile: TestNoteFileService
  readonly settings: SettingsService
  readonly localTranscription: LocalTranscriptionService
  readonly activity: ActivityPort
  readonly progress: ProgressPort
  readonly logger: LoggerService
  readonly graphSession: GraphSessionService
  readonly role?: GraphRole
}

/**
 * The native recorder and the meeting-recording pass over in-memory
 * services, for the tests of the audio-memo service that follows them.
 */
export function createTestRecordingStack(deps: TestRecordingStackDeps): {
  recorder: RecorderService
  recordings: RecordingService
} {
  const { noteFile, settings, logger, progress } = deps
  const recorder = createRecorderService({
    ipc: deps.ipc ?? createTestIpcBridgeService(),
    platform: createTestPlatformService({ isNativeShell: deps.nativeShell ?? false }),
    progress,
    logger,
  })
  const database = createTestDatabaseService()
  const contacts = createTestContactsService()
  const noteCreation = createTestNoteCreationService({ noteFile })
  const wikiResolver = createWikiResolverService({ database })
  const recordings = createRecordingService({
    recorder,
    noteFile,
    backlinkTarget: createBacklinkTargetService({ noteFile, noteCreation }),
    calendar: createTestCalendarService(),
    meetings: createMeetingService({
      noteFile,
      noteCreation,
      wikiResolver,
      suggestions: createSuggestionService({ database }),
      personNotes: createPersonNoteService({ database, wikiResolver, noteCreation }),
      contacts,
      settings,
      logger,
      graphSession: deps.graphSession,
    }),
    contacts,
    localTranscription: deps.localTranscription,
    settings,
    reconcilers: createBackgroundReconcilerFactory({ activity: deps.activity }),
    progress,
    role: deps.role ?? 'main',
    logger,
  })
  return { recorder, recordings }
}
