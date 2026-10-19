import {
  errorMessage,
  formatModelSize,
  localTranscriptionModel,
  type LocalTranscriptionModelId,
  type LocalTranscriptionService,
  type OperationHandle,
  type Unlisten,
} from '@reflect/core'
import type { OperationsService } from './operations-service.ts'

/**
 * A newer revision of a downloaded model, awaiting the user's call.
 */
export interface PendingLocalModelUpdate {
  readonly model: LocalTranscriptionModelId
  readonly etag: string
  readonly sizeBytes: number
}

/**
 * Upstream updates for the on-device transcription model. A downloaded model
 * never changes on its own: a newer revision is *offered* — as a toast with an
 * Update action, and in Settings beside Skip This Version — and dismissing the
 * toast means "later" (the next daily check offers it again). A newer model
 * generation is only announced, once: it needs an app update before Reflect
 * can use it.
 */
export interface LocalModelUpdateService {
  /**
   * The update the last check found, until it is installed, skipped or
   * cleared. The same object until it changes.
   */
  getPending: () => PendingLocalModelUpdate | null
  subscribe: (listener: () => void) => Unlisten
  /**
   * Ask upstream about `model` (throttled to once a day in Rust unless
   * `force`), and surface what it found. Network failures stay silent: the
   * next check retries.
   */
  check(model: LocalTranscriptionModelId, force: boolean): Promise<void>
  /**
   * Download the pending revision, its progress a background operation.
   */
  install(): Promise<void>
  /**
   * Never offer the pending revision again.
   */
  skip(): Promise<void>
  /**
   * Drop the pending offer (the model was deleted or switched).
   */
  clear(): void
}

export interface LocalModelUpdateServiceDeps {
  readonly localTranscription: LocalTranscriptionService
  readonly operations: OperationsService
}

class LocalModelUpdateServiceImpl implements LocalModelUpdateService {
  readonly #deps: LocalModelUpdateServiceDeps
  #pending: PendingLocalModelUpdate | null = null
  /**
   * The toast that offers {@link #pending}, while it does.
   */
  #offer: OperationHandle | null = null
  readonly #listeners = new Set<() => void>()

  constructor(deps: LocalModelUpdateServiceDeps) {
    this.#deps = deps
  }

  readonly getPending = (): PendingLocalModelUpdate | null => this.#pending

  readonly subscribe = (listener: () => void): Unlisten => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  async check(model: LocalTranscriptionModelId, force: boolean): Promise<void> {
    const { localTranscription, operations } = this.#deps
    const report = await localTranscription.checkUpdates(model, force).catch(() => null)
    if (report === null) {
      return
    }
    for (const generation of report.generations) {
      operations
        .start(`Whisper ${generation} is available`, { persistent: true })
        .warn('Reflect will offer it once an app update adds it.')
    }
    if (report.revision === null) {
      return
    }
    const { etag, sizeBytes } = report.revision
    this.#setPending({ model, etag, sizeBytes })
    this.#offer?.dismiss()
    this.#offer = operations.start('Transcription model update', {
      persistent: true,
      description: `${localTranscriptionModel(model).label} · ${formatModelSize(sizeBytes)}`,
      action: { label: 'Update', run: () => this.install() },
    })
  }

  async install(): Promise<void> {
    const { localTranscription, operations } = this.#deps
    const update = this.#pending
    if (update === null) {
      return
    }
    this.#setPending(null)
    const operation = operations.start('Updating the transcription model', { background: true })
    const unlisten = localTranscription.onStatus((model, status) => {
      if (model === update.model && status.status === 'downloading' && status.progress) {
        operation.progress(status.progress.downloaded, status.progress.total)
      }
    })
    try {
      await localTranscription.download(update.model)
      operation.done()
    } catch (cause) {
      operation.fail(errorMessage(cause))
    } finally {
      unlisten()
    }
  }

  async skip(): Promise<void> {
    const update = this.#pending
    if (update === null) {
      return
    }
    this.#setPending(null)
    await this.#deps.localTranscription.skipUpdate(update.etag)
  }

  clear(): void {
    this.#setPending(null)
  }

  #setPending(next: PendingLocalModelUpdate | null): void {
    this.#pending = next
    if (next === null) {
      this.#offer?.dismiss()
      this.#offer = null
    }
    for (const listener of this.#listeners) {
      listener()
    }
  }
}

/**
 * The offers of newer on-device transcription models, over the local
 * transcription commands.
 */
export function createLocalModelUpdateService(
  deps: LocalModelUpdateServiceDeps,
): LocalModelUpdateService {
  return new LocalModelUpdateServiceImpl(deps)
}
