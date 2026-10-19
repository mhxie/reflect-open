import { createTestGraphSessionService } from '../testing/graph-session.ts'
import { vi, type Mock, type MockInstance } from 'vitest'
import type { CaptureEnvelope } from './capture-envelope.ts'
import { captureIdentity } from './capture-identity.ts'
import { aiKeySecretName, createAiCredentialService } from '../ai/ai-credential-service.ts'
import { createAiProviderConfigService } from '../ai/ai-provider-config-service.ts'
import type { PageDescriberService } from '../ai/page-describer-service.ts'
import type { AiProvidersState } from '../ai/provider-config.ts'
import type { WebFetchService } from '../link-preview/web-fetch-service.ts'
import type { AssetStoreService } from '../graph/asset-store-service.ts'
import type { CaptureInboxService } from '../graph/capture-inbox-service.ts'
import type { NoteFileService } from '../graph/note-file-service.ts'
import { createPrivacyService } from '../privacy/privacy-service.ts'
import type { SecretStoreService } from '../secrets/secret-store-service.ts'
import {
  createTestAiKeyValidationService,
  createTestAssetStoreService,
  createTestCaptureInboxService,
  createTestClockService,
  createTestIdService,
  createTestLoggerService,
  createTestNoteFileService,
  createTestPageDescriberService,
  createTestSecretStoreService,
  createTestSettingsService,
  createTestWebFetchService,
  createTestXArchiveService,
  type TestCaptureInboxService,
  type TestClockService,
  type TestNoteFileService,
  type TestSecretStoreService,
  type TestXArchiveService,
} from '../testing/index.ts'
import type { BacklinkTargetService } from './backlink-target-service.ts'
import {
  createCaptureDrainService,
  type CaptureDrainService,
  type DrainCaptureInboxInput,
  type DrainCaptureInboxOutcome,
} from './capture-drain-service.ts'
import {
  createCaptureEnrichmentService,
  type ReconcileCaptureEnrichmentInput,
  type ReconcileCaptureEnrichmentOutcome,
} from './capture-enrichment-service.ts'
import type { PageMetaService } from './page-meta-service.ts'

/**
 * Shared setup for the capture test files (`capture-drain-service.test.ts`,
 * `capture-enrichment-service.test.ts`): the two capture phases over one set
 * of in-memory services, so a drain's writes are visible to its own dedup
 * lookups, to later drains, and to the enrichment pass — the cross-step
 * behavior the contracts are about.
 */

export const PROVIDERS: AiProvidersState = {
  providers: [{ id: 'cfg-openai', provider: 'openai', model: 'gpt-5.5', keyHint: 'wxyz1' }],
  defaultProviderId: 'cfg-openai',
}
export const NO_PROVIDERS: AiProvidersState = { providers: [], defaultProviderId: null }

/**
 * The keychain entry holding the API key of the provider in {@link PROVIDERS}.
 */
export const API_KEY_SECRET = aiKeySecretName('cfg-openai')

/**
 * 2026-06-11 15:30:22.845 local. Every derived name is asserted from it.
 */
export const CAPTURED_AT = new Date(2026, 5, 11, 15, 30, 22, 845)
export const IDENTITY = captureIdentity(CAPTURED_AT, '7c9e6679-7425-40de-944b-e07fc1f90ae7')
export const DAILY = 'daily/2026-06-11.md'
export const CAPTURE_URL = 'https://example.com/article'

/**
 * Rust's refusal of a write whose expected contents no longer match the file.
 */
export const CHANGED_ON_DISK = {
  kind: 'io',
  message: 'Note changed on disk; reload before retrying',
} as const

export function envelope(overrides: Partial<CaptureEnvelope> = {}): CaptureEnvelope {
  return {
    version: 1,
    id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
    url: CAPTURE_URL,
    title: 'An article',
    capturedAt: CAPTURED_AT.toISOString(),
    source: 'extension',
    ...overrides,
  }
}

export interface CaptureTestKit {
  /**
   * The in-memory graph notes.
   */
  noteFile: TestNoteFileService
  /**
   * The in-memory spool (`.reflect/inbox/`).
   */
  captureInbox: TestCaptureInboxService
  xArchive: TestXArchiveService
  clock: TestClockService
  writeNoteMock: MockInstance<NoteFileService['write']>
  inboxRemoveMock: MockInstance<CaptureInboxService['remove']>
  promoteMock: MockInstance<CaptureInboxService['promoteScreenshot']>
  readAssetMock: MockInstance<AssetStoreService['readBase64']>
  writeAssetMock: MockInstance<AssetStoreService['writeBase64']>
  linkPreviewMock: MockInstance<WebFetchService['fetchLinkPreviewImage']>
  scrapeMock: Mock<PageMetaService['scrape']>
  describeMock: MockInstance<PageDescriberService['describe']>
  ensureBacklinkTargetMock: Mock<BacklinkTargetService['ensure']>
  /**
   * Replace the keychain with a fresh one holding `initial` and return it.
   */
  installSecrets(initial?: Record<string, string>): TestSecretStoreService
  /**
   * Replace the keychain with one whose reads reject with `error`.
   */
  installFailingSecrets(error: Error): void
  /**
   * Stage a concurrent change: just before the next write to `path` is
   * checked, the file becomes `edit(current)` — a sync pull or an editor save
   * landing between a pass's read and its write. The note writes keep the
   * checked-write rule of the in-memory graph, so the write is refused.
   */
  raceNextWrite(path: string, edit: (current: string | undefined) => string): void
  /**
   * Stage a note that keeps changing: the next `times` writes to `path` each
   * find it changed by `edit` just before they are checked, so each is refused.
   */
  raceWrites(path: string, edit: (current: string | undefined) => string, times: number): void
  /**
   * Spool one capture (envelope JSON + screenshot sibling unless disabled).
   */
  addSpool(capture: CaptureEnvelope, options?: { screenshot?: boolean; modifiedMs?: number }): void
  /**
   * Run the drain at generation 3.
   */
  drain(overrides?: Partial<DrainCaptureInboxInput>): Promise<DrainCaptureInboxOutcome>
  /**
   * Run the enrichment pass at generation 3, with {@link PROVIDERS} configured unless overridden.
   */
  reconcile(
    overrides?: Partial<ReconcileCaptureEnrichmentInput> & { providers?: AiProvidersState },
  ): Promise<ReconcileCaptureEnrichmentOutcome>
}

class CaptureTestKitImpl implements CaptureTestKit {
  readonly noteFile: TestNoteFileService
  readonly captureInbox: TestCaptureInboxService
  readonly xArchive: TestXArchiveService
  readonly clock: TestClockService
  readonly writeNoteMock: MockInstance<NoteFileService['write']>
  readonly inboxRemoveMock: MockInstance<CaptureInboxService['remove']>
  readonly promoteMock: MockInstance<CaptureInboxService['promoteScreenshot']>
  readonly readAssetMock: MockInstance<AssetStoreService['readBase64']>
  readonly writeAssetMock: MockInstance<AssetStoreService['writeBase64']>
  readonly linkPreviewMock: MockInstance<WebFetchService['fetchLinkPreviewImage']>
  readonly scrapeMock: Mock<PageMetaService['scrape']>
  readonly describeMock: MockInstance<PageDescriberService['describe']>
  readonly ensureBacklinkTargetMock: Mock<BacklinkTargetService['ensure']>
  readonly #assetStore: AssetStoreService
  readonly #webFetch: WebFetchService
  readonly #pageDescriber: PageDescriberService
  readonly #drainService: CaptureDrainService
  /**
   * The in-memory graph's own checked write, behind {@link writeNoteMock}.
   */
  readonly #write: NoteFileService['write']
  #secretStore: SecretStoreService

  constructor() {
    const noteFile = createTestNoteFileService()
    const captureInbox = createTestCaptureInboxService()
    const assetStore = createTestAssetStoreService()
    const webFetch = createTestWebFetchService()
    const xArchive = createTestXArchiveService()
    const pageDescriber = createTestPageDescriberService({
      title: null,
      description: 'An AI description of the page.',
    })
    const clock = createTestClockService({ now: Date.now() })

    const scrapeMock = vi
      .fn<PageMetaService['scrape']>()
      .mockResolvedValue({ title: 'An article', description: null, siteName: null })
    const ensureBacklinkTargetMock = vi
      .fn<BacklinkTargetService['ensure']>()
      .mockResolvedValue('Links')

    this.noteFile = noteFile
    this.captureInbox = captureInbox
    this.xArchive = xArchive
    this.clock = clock
    this.#write = noteFile.write.bind(noteFile)
    this.writeNoteMock = vi.spyOn(noteFile, 'write')
    this.inboxRemoveMock = vi.spyOn(captureInbox, 'remove')
    this.promoteMock = vi.spyOn(captureInbox, 'promoteScreenshot')
    // The inbox fake promotes without writing the asset, so every screenshot reads as these bytes.
    this.readAssetMock = vi.spyOn(assetStore, 'readBase64').mockResolvedValue(btoa('jpeg-bytes'))
    this.writeAssetMock = vi.spyOn(assetStore, 'writeBase64')
    this.linkPreviewMock = vi.spyOn(webFetch, 'fetchLinkPreviewImage')
    this.scrapeMock = scrapeMock
    this.describeMock = vi.spyOn(pageDescriber, 'describe')
    this.ensureBacklinkTargetMock = ensureBacklinkTargetMock
    this.#assetStore = assetStore
    this.#webFetch = webFetch
    this.#pageDescriber = pageDescriber
    this.#secretStore = createTestSecretStoreService({ [API_KEY_SECRET]: 'sk-live-key' })
    this.#drainService = createCaptureDrainService({
      captureInbox,
      noteFile,
      xArchive,
      backlinkTarget: { ensure: ensureBacklinkTargetMock },
      clock,
      logger: createTestLoggerService(),
    })
  }

  installSecrets(initial: Record<string, string> = {}): TestSecretStoreService {
    const store = createTestSecretStoreService(initial)
    this.#secretStore = store
    return store
  }

  installFailingSecrets(error: Error): void {
    const store = createTestSecretStoreService()
    vi.spyOn(store, 'get').mockRejectedValue(error)
    this.#secretStore = store
  }

  raceNextWrite(path: string, edit: (current: string | undefined) => string): void {
    this.raceWrites(path, edit, 1)
  }

  raceWrites(path: string, edit: (current: string | undefined) => string, times: number): void {
    let remaining = times
    this.writeNoteMock.mockImplementation(async (target, contents, generation, expected) => {
      if (remaining > 0 && target === path) {
        remaining -= 1
        this.noteFile.set(path, edit(this.noteFile.files().get(path)))
      }
      return await this.#write(target, contents, generation, expected)
    })
  }

  addSpool(
    capture: CaptureEnvelope,
    options: { screenshot?: boolean; modifiedMs?: number } = {},
  ): void {
    const withRef = {
      ...capture,
      screenshotRef: options.screenshot === false ? undefined : `${capture.id}.jpg`,
    }
    const modifiedMs = options.modifiedMs ?? 0
    this.captureInbox.add(`${capture.id}.json`, withRef, { modifiedMs })
    if (options.screenshot !== false) {
      this.captureInbox.add(`${capture.id}.jpg`, 'jpeg', { modifiedMs })
    }
  }

  drain(overrides: Partial<DrainCaptureInboxInput> = {}): Promise<DrainCaptureInboxOutcome> {
    return this.#drainService.drain({ generation: 3, ...overrides })
  }

  async reconcile(
    overrides: Partial<ReconcileCaptureEnrichmentInput> & { providers?: AiProvidersState } = {},
  ): Promise<ReconcileCaptureEnrichmentOutcome> {
    const { providers = PROVIDERS, ...input } = overrides
    const settings = createTestSettingsService({
      aiProviders: providers.providers,
      defaultAiProviderId: providers.defaultProviderId,
    })
    await settings.whenLoaded()
    const enrichment = createCaptureEnrichmentService({
      noteFile: this.noteFile,
      assetStore: this.#assetStore,
      webFetch: this.#webFetch,
      pageMeta: { scrape: this.scrapeMock },
      pageDescriber: this.#pageDescriber,
      aiProviderConfig: createAiProviderConfigService({
        settings,
        credentials: createAiCredentialService({ secretStore: createTestSecretStoreService() }),
        keyValidation: createTestAiKeyValidationService(),
        id: createTestIdService(),
      }),
      aiCredentials: createAiCredentialService({ secretStore: this.#secretStore }),
      privacy: createPrivacyService({
        noteFile: this.noteFile,
        graphSession: createTestGraphSessionService({ graph: { generation: 1 } }),
      }),
    })
    return await enrichment.reconcile({ generation: 3, ...input })
  }
}

/**
 * Fresh in-memory services with the capture phases built on them; call from `beforeEach`.
 */
export function createCaptureTestKit(): CaptureTestKit {
  return new CaptureTestKitImpl()
}
