import { z } from 'zod'
import type { IpcBridgeService } from '../ipc/ipc-service.ts'
import type { LoggerService } from '../ports/logger-service.ts'
import type { Unlisten } from '../unlisten.ts'
import {
  localModelStatusSchema,
  localModelUpdateReportSchema,
  localTranscriptSchema,
  type LocalModelStatus,
  type LocalModelUpdateReport,
  type LocalTranscript,
  type TranscribeLocallyInput,
} from './local-transcription.ts'
import type { LocalTranscriptionModelId } from './local-transcription-models.ts'

const statusEventSchema = z.object({ model: z.string(), status: localModelStatusSchema })

/**
 * Called with every status change of any local transcription model.
 */
export type LocalModelStatusListener = (model: string, status: LocalModelStatus) => void

/**
 * The on-device transcription models: their downloads, updates and statuses,
 * and transcribing one stored recording with one of them.
 */
export interface LocalTranscriptionService {
  /**
   * The model's status (poll on mount; changes arrive through
   * {@link LocalTranscriptionService.onStatus}).
   */
  status(model: LocalTranscriptionModelId): Promise<LocalModelStatus>
  /**
   * Download the model, or its newer upstream revision when one is on disk.
   * Rejects with the download's error; progress streams as status events.
   */
  download(model: LocalTranscriptionModelId): Promise<LocalModelStatus>
  /**
   * Delete the model's files.
   */
  delete(model: LocalTranscriptionModelId): Promise<LocalModelStatus>
  /**
   * Transcribe one stored recording on this device.
   */
  transcribe(input: TranscribeLocallyInput): Promise<LocalTranscript>
  /**
   * Ask upstream for newer weights; throttled daily in Rust unless `force`.
   */
  checkUpdates(model: LocalTranscriptionModelId, force: boolean): Promise<LocalModelUpdateReport>
  /**
   * Stop offering the upstream revision `etag`.
   */
  skipUpdate(etag: string): Promise<void>
  /**
   * Live status changes for every model (download progress, completion,
   * failure). Registers synchronously; one native listener serves every
   * subscriber while any is attached.
   */
  onStatus(listener: LocalModelStatusListener): Unlisten
}

const STATUS_EVENT = 'local-transcription:status'

const voidSchema = z.null()

export interface LocalTranscriptionServiceDeps {
  readonly ipc: IpcBridgeService
  readonly logger: LoggerService
}

class LocalTranscriptionServiceImpl implements LocalTranscriptionService {
  readonly #deps: LocalTranscriptionServiceDeps
  readonly #listeners = new Set<LocalModelStatusListener>()
  #stopEvents: Unlisten | null = null

  constructor(deps: LocalTranscriptionServiceDeps) {
    this.#deps = deps
  }

  async status(model: LocalTranscriptionModelId): Promise<LocalModelStatus> {
    return await this.#deps.ipc.call(
      'local_transcription_status',
      { model },
      localModelStatusSchema,
    )
  }

  async download(model: LocalTranscriptionModelId): Promise<LocalModelStatus> {
    return await this.#deps.ipc.call(
      'local_transcription_download',
      { model },
      localModelStatusSchema,
    )
  }

  async delete(model: LocalTranscriptionModelId): Promise<LocalModelStatus> {
    return await this.#deps.ipc.call(
      'local_transcription_delete',
      { model },
      localModelStatusSchema,
    )
  }

  async transcribe(input: TranscribeLocallyInput): Promise<LocalTranscript> {
    return await this.#deps.ipc.call(
      'local_transcription_transcribe',
      {
        request: {
          path: input.path,
          generation: input.generation,
          model: input.model,
          languages: input.languages,
          prompt: input.prompt === '' ? null : input.prompt,
        },
      },
      localTranscriptSchema,
    )
  }

  async checkUpdates(
    model: LocalTranscriptionModelId,
    force: boolean,
  ): Promise<LocalModelUpdateReport> {
    return await this.#deps.ipc.call(
      'local_transcription_check_updates',
      { model, force },
      localModelUpdateReportSchema,
    )
  }

  async skipUpdate(etag: string): Promise<void> {
    await this.#deps.ipc.call('local_transcription_skip_update', { etag }, voidSchema)
  }

  onStatus(listener: LocalModelStatusListener): Unlisten {
    // Wrapped for identity, so one function added twice detaches independently.
    const deliver: LocalModelStatusListener = (model, status) => {
      listener(model, status)
    }
    this.#listeners.add(deliver)
    this.#stopEvents ??= this.#startEvents()
    let attached = true
    return () => {
      if (!attached) {
        return
      }
      attached = false
      this.#listeners.delete(deliver)
      if (this.#listeners.size === 0) {
        this.#stopEvents?.()
        this.#stopEvents = null
      }
    }
  }

  #onEvent(payload: unknown): void {
    const parsed = statusEventSchema.safeParse(payload)
    if (!parsed.success) {
      this.#deps.logger.error(`invalid ${STATUS_EVENT} payload:`, parsed.error)
      return
    }
    for (const listener of this.#listeners) {
      try {
        listener(parsed.data.model, parsed.data.status)
      } catch (cause) {
        this.#deps.logger.error('local transcription status listener failed:', cause)
      }
    }
  }

  // One native listener shared by every subscriber while any is attached.
  #startEvents(): Unlisten {
    const { ipc, logger } = this.#deps
    let stopped = false
    let unlisten: Unlisten | null = null
    void (async () => {
      try {
        const registration = await ipc.listen(STATUS_EVENT, (payload) => {
          this.#onEvent(payload)
        })
        if (stopped) {
          registration()
        } else {
          unlisten = registration
        }
      } catch (cause) {
        if (!stopped) {
          logger.warn(`failed to listen for "${STATUS_EVENT}"`, cause)
        }
      }
    })()
    return () => {
      stopped = true
      unlisten?.()
      unlisten = null
    }
  }
}

export function createLocalTranscriptionService(
  deps: LocalTranscriptionServiceDeps,
): LocalTranscriptionService {
  return new LocalTranscriptionServiceImpl(deps)
}
