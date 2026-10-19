import type { MaybePromise } from '@reflect/utils'
import type { LanguageModel } from '@reflect/modules/ai'
import { MockLanguageModelV3 } from '@reflect/modules/ai/test'
import type {
  AiKeyValidationService,
  ApiKeyValidation,
  ApiKeyValidationInput,
} from '../ai/ai-key-validation-service.ts'
import type { LanguageModelService, TargetModel } from '../ai/language-model-service.ts'
import type { AssetDescriberService, DescribeAssetRequest } from '../ai/asset-describer-service.ts'
import type {
  DescribePageRequest,
  PageDescriberService,
  PageEnrichment,
} from '../ai/page-describer-service.ts'
import {
  createTranscriptionService,
  type TranscriptionRequest,
  type TranscriptionService,
} from '../ai/transcription-service.ts'
import {
  createOnDeviceHttpService,
  type OnDeviceHttpService,
} from '../ai/on-device-http-service.ts'
import type { OnDeviceModelService } from '../ai/on-device-model-service.ts'
import type { ListOllamaModelsOptions, OllamaModels } from '../ai/ollama-models.ts'
import {
  verifyModelTarget,
  type ModelTarget,
  type VerifiedModelTarget,
} from '../privacy/on-device.ts'
import type { OnDeviceTarget } from '../privacy/on-device-target.ts'
import type {
  OnDeviceServerVerdict,
  OnDeviceVerificationOptions,
} from '../privacy/on-device-verification.ts'
import type { AiProviderConfig } from '../settings/schema.ts'
import { z } from 'zod'
import { AppError } from '../errors.ts'
import type {
  LocalModelStatus,
  LocalModelUpdateReport,
  LocalTranscript,
  TranscribeLocallyInput,
} from '../ai/local-transcription.ts'
import {
  createLocalTranscriptionService,
  type LocalModelStatusListener,
  type LocalTranscriptionService,
} from '../ai/local-transcription-service.ts'
import type { LocalTranscriptionModelId } from '../ai/local-transcription-models.ts'
import type { Unlisten } from '../unlisten.ts'
import { createTestIdService } from './id.ts'
import { createTestIpcBridgeService, type TestIpcBridgeService } from './ipc.ts'
import { createTestLoggerService } from './logger.ts'

/**
 * A model, or a function that answers each `create` call.
 */
export type TestLanguageModelSource =
  | LanguageModel
  | ((config: AiProviderConfig, apiKey: string) => MaybePromise<LanguageModel>)

/**
 * A `create` call the fake received.
 */
export interface TestLanguageModelCall {
  config: AiProviderConfig
  apiKey: string
}

export interface TestLanguageModelService extends LanguageModelService {
  /**
   * Every `create` call, in order.
   */
  calls(): readonly TestLanguageModelCall[]
  /**
   * Replaces the model that later `create` calls answer with.
   */
  setModel(model: TestLanguageModelSource): void
}

class TestLanguageModelServiceImpl implements TestLanguageModelService {
  #source: TestLanguageModelSource
  readonly #log: TestLanguageModelCall[] = []

  constructor(source: TestLanguageModelSource) {
    this.#source = source
  }

  async create(config: AiProviderConfig, apiKey: string): Promise<LanguageModel> {
    this.#log.push({ config, apiKey })
    const source = this.#source
    return typeof source === 'function' ? await source(config, apiKey) : source
  }

  async createFor<TTarget extends ModelTarget>(
    target: TTarget,
    apiKey: string,
  ): Promise<TargetModel<TTarget>> {
    const model = await this.create(target.config, apiKey)
    // Binds the scripted model to the target the way the real service does.
    return Object.freeze({ target, model }) as TargetModel<TTarget>
  }

  calls(): readonly TestLanguageModelCall[] {
    return [...this.#log]
  }

  setModel(model: TestLanguageModelSource): void {
    this.#source = model
  }
}

/**
 * A {@link LanguageModelService} that answers every `create` call with
 * `model`, an empty `MockLanguageModelV3` by default. No provider SDK loads
 * and no request leaves the process.
 */
export function createTestLanguageModelService(
  model: TestLanguageModelSource = new MockLanguageModelV3(),
): TestLanguageModelService {
  return new TestLanguageModelServiceImpl(model)
}

export interface TestAiKeyValidationService extends AiKeyValidationService {
  /**
   * Every input passed to `validate()`, in order.
   */
  calls(): readonly ApiKeyValidationInput[]
  /**
   * Replaces the result that later `validate()` calls answer with.
   */
  setResult(result: ApiKeyValidation): void
}

class TestAiKeyValidationServiceImpl implements TestAiKeyValidationService {
  #current: ApiKeyValidation
  readonly #log: ApiKeyValidationInput[] = []

  constructor(result: ApiKeyValidation) {
    this.#current = result
  }

  validate(input: ApiKeyValidationInput): ApiKeyValidation {
    this.#log.push(input)
    return this.#current
  }

  calls(): readonly ApiKeyValidationInput[] {
    return [...this.#log]
  }

  setResult(result: ApiKeyValidation): void {
    this.#current = result
  }
}

/**
 * An {@link AiKeyValidationService} that answers `result` without any request.
 */
export function createTestAiKeyValidationService(
  result: ApiKeyValidation = 'valid',
): TestAiKeyValidationService {
  return new TestAiKeyValidationServiceImpl(result)
}

/**
 * A page enrichment, or a function that answers each `describe` call.
 */
export type TestPageDescriberSource =
  | PageEnrichment
  | ((request: DescribePageRequest) => MaybePromise<PageEnrichment>)

export interface TestPageDescriberService extends PageDescriberService {
  /**
   * Every request passed to `describe()`, in order.
   */
  calls(): readonly DescribePageRequest[]
  /**
   * Replaces the result that later `describe()` calls answer with.
   */
  setResult(result: TestPageDescriberSource): void
}

class TestPageDescriberServiceImpl implements TestPageDescriberService {
  #source: TestPageDescriberSource
  readonly #log: DescribePageRequest[] = []

  constructor(result: TestPageDescriberSource) {
    this.#source = result
  }

  async describe(request: DescribePageRequest): Promise<PageEnrichment> {
    this.#log.push(request)
    const source = this.#source
    return typeof source === 'function' ? await source(request) : source
  }

  calls(): readonly DescribePageRequest[] {
    return [...this.#log]
  }

  setResult(result: TestPageDescriberSource): void {
    this.#source = result
  }
}

/**
 * A {@link PageDescriberService} that answers `result` without any provider
 * call: no title and an empty description by default.
 */
export function createTestPageDescriberService(
  result: TestPageDescriberSource = { title: null, description: '' },
): TestPageDescriberService {
  return new TestPageDescriberServiceImpl(result)
}

/**
 * A description, or a function that answers each `describe` call.
 */
export type TestAssetDescriberSource =
  | string
  | ((request: DescribeAssetRequest) => MaybePromise<string>)

export interface TestAssetDescriberService extends AssetDescriberService {
  /**
   * Every request passed to `describe()`, in order.
   */
  calls(): readonly DescribeAssetRequest[]
  /**
   * Replaces the result that later `describe()` calls answer with.
   */
  setResult(result: TestAssetDescriberSource): void
}

class TestAssetDescriberServiceImpl implements TestAssetDescriberService {
  #source: TestAssetDescriberSource
  readonly #log: DescribeAssetRequest[] = []

  constructor(result: TestAssetDescriberSource) {
    this.#source = result
  }

  async describe(request: DescribeAssetRequest): Promise<string> {
    this.#log.push(request)
    const source = this.#source
    return typeof source === 'function' ? await source(request) : source
  }

  calls(): readonly DescribeAssetRequest[] {
    return [...this.#log]
  }

  setResult(result: TestAssetDescriberSource): void {
    this.#source = result
  }
}

/**
 * An {@link AssetDescriberService} that answers `result` without any provider
 * call: an empty description by default.
 */
export function createTestAssetDescriberService(
  result: TestAssetDescriberSource = '',
): TestAssetDescriberService {
  return new TestAssetDescriberServiceImpl(result)
}

/**
 * A transcript, or a function that answers each `transcribe` call.
 */
export type TestTranscriptionSource =
  | string
  | ((request: TranscriptionRequest) => MaybePromise<string>)

export interface TestTranscriptionService extends TranscriptionService {
  /**
   * Every request passed to `transcribe()`, in order.
   */
  calls(): readonly TranscriptionRequest[]
  /**
   * Replaces the result that later `transcribe()` calls answer with.
   */
  setResult(result: TestTranscriptionSource): void
}

class TestTranscriptionServiceImpl implements TestTranscriptionService {
  #source: TestTranscriptionSource
  readonly #log: TranscriptionRequest[] = []
  readonly #real: TranscriptionService

  constructor(result: TestTranscriptionSource) {
    this.#source = result
    this.#real = createTranscriptionService({
      http: {
        fetch: () => Promise.reject(new Error('The test transcription service has no network')),
      },
    })
  }

  async transcribe(request: TranscriptionRequest): Promise<string> {
    this.#log.push(request)
    const source = this.#source
    return typeof source === 'function' ? await source(request) : source
  }

  sessionTranscript(apiKey: string): string | null {
    return this.#real.sessionTranscript(apiKey)
  }

  calls(): readonly TranscriptionRequest[] {
    return [...this.#log]
  }

  setResult(result: TestTranscriptionSource): void {
    this.#source = result
  }
}

/**
 * A {@link TranscriptionService} that answers `result` without any request:
 * an empty transcript by default. `sessionTranscript` is the real one, so the
 * App Review demo key gets its canned transcript.
 */
export function createTestTranscriptionService(
  result: TestTranscriptionSource = '',
): TestTranscriptionService {
  return new TestTranscriptionServiceImpl(result)
}

const onDeviceSendArgsSchema = z.object({
  requestId: z.string(),
  method: z.string(),
  url: z.string(),
  headers: z.array(z.tuple([z.string(), z.string()])),
  body: z.union([
    z.object({ kind: z.literal('text'), text: z.string() }),
    z.object({ kind: z.literal('base64'), data: z.string() }),
    z.null(),
  ]),
})

const onDeviceRequestIdSchema = z.object({ requestId: z.string() })

/**
 * A request as the on-device transport's `on_device_http_send` received it.
 */
export type TestOnDeviceRequest = z.infer<typeof onDeviceSendArgsSchema>

/**
 * How the fake server on this Mac answers one request.
 */
export interface TestOnDeviceResponse {
  status?: number
  statusText?: string
  headers?: Array<[string, string]>
  /**
   * The body, one `on_device_http_read` per chunk.
   */
  chunks?: string[]
}

export interface TestOnDeviceHttpService extends OnDeviceHttpService {
  /**
   * Every request sent, in order.
   */
  requests(): readonly TestOnDeviceRequest[]
  /**
   * Request ids `on_device_http_cancel` named, in order.
   */
  cancelled(): readonly string[]
  /**
   * Ids whose body was neither read to its end nor cancelled.
   */
  openRequests(): readonly string[]
}

function arrayBufferOf(text: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(text)
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
}

class TestOnDeviceHttpServiceImpl implements TestOnDeviceHttpService {
  readonly #inner: OnDeviceHttpService
  readonly #requests: TestOnDeviceRequest[] = []
  readonly #cancelled: string[] = []
  readonly #bodies = new Map<string, string[]>()

  constructor(respond: (request: TestOnDeviceRequest) => TestOnDeviceResponse) {
    const ipc = createTestIpcBridgeService({
      commands: {
        on_device_http_send: (args) => {
          const request = onDeviceSendArgsSchema.parse(args)
          this.#requests.push(request)
          const response = respond(request)
          this.#bodies.set(request.requestId, [...(response.chunks ?? [])])
          return {
            status: response.status ?? 200,
            statusText: response.statusText ?? 'OK',
            headers: response.headers ?? [],
          }
        },
        on_device_http_read: (args) => {
          const { requestId } = onDeviceRequestIdSchema.parse(args)
          const chunks = this.#bodies.get(requestId)
          if (chunks === undefined) {
            throw new AppError('notFound', 'no such on-device request')
          }
          const chunk = chunks.shift()
          if (chunk === undefined) {
            this.#bodies.delete(requestId)
            return new ArrayBuffer(0)
          }
          return arrayBufferOf(chunk)
        },
        on_device_http_cancel: (args) => {
          const { requestId } = onDeviceRequestIdSchema.parse(args)
          this.#cancelled.push(requestId)
          this.#bodies.delete(requestId)
          return null
        },
      },
    })
    this.#inner = createOnDeviceHttpService({ ipc, id: createTestIdService() })
  }

  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    return this.#inner.fetch(input, init)
  }

  requests(): readonly TestOnDeviceRequest[] {
    return [...this.#requests]
  }

  cancelled(): readonly string[] {
    return [...this.#cancelled]
  }

  openRequests(): readonly string[] {
    return [...this.#bodies.keys()]
  }
}

/**
 * The real {@link OnDeviceHttpService} over a fake server on this Mac that
 * answers every request with `respond` (`200 OK` with an empty body by
 * default), recording what reached it.
 */
export function createTestOnDeviceHttpService(
  respond: (request: TestOnDeviceRequest) => TestOnDeviceResponse = () => ({}),
): TestOnDeviceHttpService {
  return new TestOnDeviceHttpServiceImpl(respond)
}

/**
 * One `verify` call the fake received.
 */
export interface TestOnDeviceVerifyCall {
  target: ModelTarget
  apiKey: string
}

export interface TestOnDeviceModelServiceOptions {
  /**
   * What every server check concludes. Defaults to `'ok'`.
   */
  verdict?: OnDeviceServerVerdict
  /**
   * What the Ollama listing answers. Defaults to `{ kind: 'unreachable' }`.
   */
  ollama?: OllamaModels
}

export interface TestOnDeviceModelService extends OnDeviceModelService {
  /**
   * Every `verify` call, in order.
   */
  verifyCalls(): readonly TestOnDeviceVerifyCall[]
  /**
   * Replaces the verdict later server checks conclude.
   */
  setVerdict(verdict: OnDeviceServerVerdict): void
  /**
   * Replaces what later Ollama listings answer.
   */
  setOllama(ollama: OllamaModels): void
}

class TestOnDeviceModelServiceImpl implements TestOnDeviceModelService {
  #verdict: OnDeviceServerVerdict
  #ollama: OllamaModels
  readonly #verifyLog: TestOnDeviceVerifyCall[] = []

  constructor(options?: TestOnDeviceModelServiceOptions) {
    this.#verdict = options?.verdict ?? 'ok'
    this.#ollama = options?.ollama ?? { kind: 'unreachable' }
  }

  async verify(
    target: ModelTarget,
    apiKey: string,
    signal?: AbortSignal,
  ): Promise<VerifiedModelTarget> {
    this.#verifyLog.push({ target, apiKey })
    return await verifyModelTarget(target, (onDevice) =>
      this.verifyServer(onDevice, { apiKey, signal }),
    )
  }

  verifyServer(
    _target: OnDeviceTarget,
    options?: OnDeviceVerificationOptions,
  ): Promise<OnDeviceServerVerdict> {
    // The executor turns an abort into a rejection.
    return new Promise((resolve) => {
      options?.signal?.throwIfAborted()
      resolve(this.#verdict)
    })
  }

  listOllamaModels(options?: ListOllamaModelsOptions): Promise<OllamaModels> {
    return new Promise((resolve) => {
      options?.signal?.throwIfAborted()
      resolve(this.#ollama)
    })
  }

  verifyCalls(): readonly TestOnDeviceVerifyCall[] {
    return [...this.#verifyLog]
  }

  setVerdict(verdict: OnDeviceServerVerdict): void {
    this.#verdict = verdict
  }

  setOllama(ollama: OllamaModels): void {
    this.#ollama = ollama
  }
}

/**
 * A scripted {@link OnDeviceModelService}: every server check concludes
 * `options.verdict` (`'ok'` by default) without a request, so an attested
 * target verifies; `verify` mints through the real rule, so a refusal still
 * rejects with `AppError('auth', reason)`.
 */
export function createTestOnDeviceModelService(
  options?: TestOnDeviceModelServiceOptions,
): TestOnDeviceModelService {
  return new TestOnDeviceModelServiceImpl(options)
}

export interface TestLocalTranscriptionServiceOptions {
  /**
   * What `status`, `download` and `delete` answer. Defaults to `{ status: 'ready' }`.
   */
  status?: LocalModelStatus
  /**
   * The transcript of each recording, by graph-relative path; any other path
   * transcribes as an empty transcript.
   */
  transcripts?: Readonly<Record<string, LocalTranscript>>
  /**
   * What `checkUpdates` answers. Defaults to nothing new.
   */
  updates?: LocalModelUpdateReport
}

export interface TestLocalTranscriptionService extends LocalTranscriptionService {
  /**
   * Every `transcribe` input, in order.
   */
  transcribeCalls(): readonly TranscribeLocallyInput[]
  /**
   * Change what later status reads answer, and emit it to `onStatus` listeners for `model`.
   */
  setStatus(model: string, status: LocalModelStatus): void
}

class TestLocalTranscriptionServiceImpl implements TestLocalTranscriptionService {
  readonly #inner: LocalTranscriptionService
  readonly #ipc: TestIpcBridgeService
  readonly #transcripts: Readonly<Record<string, LocalTranscript>>
  readonly #transcribeLog: TranscribeLocallyInput[] = []
  #status: LocalModelStatus

  constructor(options?: TestLocalTranscriptionServiceOptions) {
    this.#status = options?.status ?? { status: 'ready' }
    this.#transcripts = options?.transcripts ?? {}
    const updates = options?.updates ?? { revision: null, generations: [] }
    this.#ipc = createTestIpcBridgeService({
      commands: {
        local_transcription_status: () => this.#status,
        local_transcription_download: () => this.#status,
        local_transcription_delete: () => this.#status,
        local_transcription_check_updates: () => updates,
        local_transcription_skip_update: () => null,
      },
    })
    this.#inner = createLocalTranscriptionService({
      ipc: this.#ipc,
      logger: createTestLoggerService(),
    })
  }

  status(model: LocalTranscriptionModelId): Promise<LocalModelStatus> {
    return this.#inner.status(model)
  }

  download(model: LocalTranscriptionModelId): Promise<LocalModelStatus> {
    return this.#inner.download(model)
  }

  delete(model: LocalTranscriptionModelId): Promise<LocalModelStatus> {
    return this.#inner.delete(model)
  }

  transcribe(input: TranscribeLocallyInput): Promise<LocalTranscript> {
    this.#transcribeLog.push(input)
    return Promise.resolve(
      this.#transcripts[input.path] ?? { outcome: 'transcribed', text: '', segments: [] },
    )
  }

  checkUpdates(model: LocalTranscriptionModelId, force: boolean): Promise<LocalModelUpdateReport> {
    return this.#inner.checkUpdates(model, force)
  }

  skipUpdate(etag: string): Promise<void> {
    return this.#inner.skipUpdate(etag)
  }

  onStatus(listener: LocalModelStatusListener): Unlisten {
    return this.#inner.onStatus(listener)
  }

  transcribeCalls(): readonly TranscribeLocallyInput[] {
    return [...this.#transcribeLog]
  }

  setStatus(model: string, status: LocalModelStatus): void {
    this.#status = status
    this.#ipc.emit('local-transcription:status', { model, status })
  }
}

/**
 * A {@link LocalTranscriptionService} over a scripted device: the real model
 * reads and status events over a test bridge, where every model reports
 * `options.status` (`ready` by default), and a scripted `transcribe` that
 * answers `options.transcripts` without touching any audio.
 */
export function createTestLocalTranscriptionService(
  options?: TestLocalTranscriptionServiceOptions,
): TestLocalTranscriptionService {
  return new TestLocalTranscriptionServiceImpl(options)
}
