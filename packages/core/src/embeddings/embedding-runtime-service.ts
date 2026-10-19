import { z } from 'zod'
import type { LoggerService } from '../ports/logger-service.ts'
import type { IpcBridgeService } from '../ipc/ipc-service.ts'
import type { Unlisten } from '../unlisten.ts'

/**

 * Byte counts for an active model download; absent until it starts.

 */
export const embedProgressSchema = z.object({
  /**
   * Bytes fetched so far.
   */
  downloaded: z.number().int().nonnegative(),
  /**
   * Bytes the download will fetch in total.
   */
  total: z.number().int().nonnegative(),
})
export type EmbedProgress = z.infer<typeof embedProgressSchema>

export const embedStatusSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('uninitialized') }),
  z.object({
    status: z.literal('loading'),
    progress: embedProgressSchema.optional(),
  }),
  z.object({
    status: z.literal('ready'),
    model: z.string(),
    /**
     * The width the model's vectors (and so the vector table) have.
     */
    dims: z.number().int().positive(),
  }),
  z.object({ status: z.literal('failed'), message: z.string() }),
  z.object({ status: z.literal('unsupported') }),
])
export type EmbedStatus = z.infer<typeof embedStatusSchema>

const vectorsSchema = z.array(z.array(z.number()))

/**
 * What a text is embedded as: a search query and a stored passage take the
 * different prefixes the model was trained with.
 */
export type EmbedTextRole = 'query' | 'passage'

/**
 * The local embedding model (Plan 09): download, load, status, and text
 * vectors. Platforms without a runtime answer `unsupported`.
 */
export interface EmbeddingRuntimeService {
  /**
   * Poll the runtime status.
   */
  status(): Promise<EmbedStatus>
  /**
   * Load `model` (downloading on first use; the runtime's default when
   * absent), replacing any other loaded model. Resolves with the outcome, or
   * with `loading` when another caller's load is in flight.
   */
  ensure(model?: string): Promise<EmbedStatus>
  /**
   * Resolve once the runtime leaves `uninitialized` / `loading`, starting
   * from `initial` (usually what {@link ensure} returned).
   */
  awaitTerminalStatus(initial: EmbedStatus): Promise<EmbedStatus>
  /**
   * Re-load a `failed` model (`model`, or the runtime's default) and resolve
   * with the outcome; any other status resolves as is. A reload that throws
   * resolves as `failed`.
   */
  retry(model?: string): Promise<EmbedStatus>
  /**
   * Embed `texts` with the loaded model, as `role` (a stored passage by
   * default). Rejects unless the status is `ready` and, when `model` is
   * given, the loaded model is that one: a caller that read the model id
   * before a switch must not get another model's vectors (of another width)
   * under that id.
   */
  embedTexts(texts: readonly string[], role?: EmbedTextRole, model?: string): Promise<number[][]>
  /**
   * Call `listener` with every status this service observes (events and polls).
   */
  subscribe(listener: (status: EmbedStatus) => void): Unlisten
  /**
   * The last observed status; `uninitialized` before the first one.
   */
  lastStatus(): EmbedStatus
}

const STATUS_EVENT = 'embed:status'

const UNINITIALIZED: EmbedStatus = { status: 'uninitialized' }

function isTerminalStatus(status: EmbedStatus): boolean {
  return status.status !== 'uninitialized' && status.status !== 'loading'
}

function failedStatus(cause: unknown): EmbedStatus {
  return { status: 'failed', message: cause instanceof Error ? cause.message : String(cause) }
}

interface StatusEvents {
  /**
   * Settles once the native listener is registered (`null`), or with why it
   * failed to register.
   */
  registered: Promise<{ readonly cause: unknown } | null>
  stop: Unlisten
}

export interface EmbeddingRuntimeServiceDeps {
  readonly ipc: IpcBridgeService
  readonly logger: LoggerService
}

class EmbeddingRuntimeServiceImpl implements EmbeddingRuntimeService {
  readonly #deps: EmbeddingRuntimeServiceDeps
  readonly #listeners = new Set<(status: EmbedStatus) => void>()
  #last = UNINITIALIZED
  #events: StatusEvents | null = null

  constructor(deps: EmbeddingRuntimeServiceDeps) {
    this.#deps = deps
  }

  async status(): Promise<EmbedStatus> {
    return this.#observe(await this.#deps.ipc.call('embed_status', {}, embedStatusSchema))
  }

  async ensure(model?: string): Promise<EmbedStatus> {
    return this.#observe(
      await this.#deps.ipc.call('embed_ensure', { model: model ?? null }, embedStatusSchema),
    )
  }

  async awaitTerminalStatus(initial: EmbedStatus): Promise<EmbedStatus> {
    const { logger } = this.#deps
    if (isTerminalStatus(initial)) {
      return initial
    }
    return await new Promise((resolve) => {
      const unsubscribe = this.subscribe((next) => {
        if (isTerminalStatus(next)) {
          unsubscribe()
          resolve(next)
        }
      })
      void (this.#events?.registered ?? Promise.resolve(null)).then(async (failure) => {
        if (failure !== null) {
          // Without the event stream no terminal status can arrive: settle now.
          unsubscribe()
          resolve(failedStatus(failure.cause))
          return
        }
        // The terminal event may have fired before the listener registered.
        try {
          await this.status()
        } catch (cause) {
          logger.warn('failed to poll the embedding runtime status', cause)
        }
      })
    })
  }

  async retry(model?: string): Promise<EmbedStatus> {
    const current = await this.status()
    if (current.status !== 'failed') {
      return current
    }
    try {
      return await this.awaitTerminalStatus(await this.ensure(model))
    } catch (cause) {
      return failedStatus(cause)
    }
  }

  embedTexts(
    texts: readonly string[],
    role: EmbedTextRole = 'passage',
    model?: string,
  ): Promise<number[][]> {
    return this.#deps.ipc.call(
      'embed_texts',
      { texts: [...texts], role, model: model ?? null },
      vectorsSchema,
    )
  }

  subscribe(listener: (status: EmbedStatus) => void): Unlisten {
    // Wrapped for identity, so one function added twice detaches independently.
    const deliver = (status: EmbedStatus): void => {
      listener(status)
    }
    this.#listeners.add(deliver)
    this.#events ??= this.#startEvents()
    let attached = true
    return () => {
      if (!attached) {
        return
      }
      attached = false
      this.#listeners.delete(deliver)
      if (this.#listeners.size === 0) {
        this.#events?.stop()
        this.#events = null
      }
    }
  }

  lastStatus(): EmbedStatus {
    return this.#last
  }

  #observe(status: EmbedStatus): EmbedStatus {
    this.#last = status
    for (const listener of this.#listeners) {
      listener(status)
    }
    return status
  }

  #onEvent(payload: unknown): void {
    const parsed = embedStatusSchema.safeParse(payload)
    if (parsed.success) {
      this.#observe(parsed.data)
    } else {
      this.#deps.logger.error(`invalid ${STATUS_EVENT} payload:`, parsed.error)
    }
  }

  // One native listener shared by every subscriber while any is attached.
  #startEvents(): StatusEvents {
    const { ipc, logger } = this.#deps
    let stopped = false
    let unlisten: Unlisten | null = null
    const registered = (async (): Promise<{ readonly cause: unknown } | null> => {
      try {
        const registration = await ipc.listen(STATUS_EVENT, (payload) => {
          this.#onEvent(payload)
        })
        if (stopped) {
          registration()
        } else {
          unlisten = registration
        }
        return null
      } catch (cause) {
        if (!stopped) {
          logger.warn(`failed to listen for "${STATUS_EVENT}"`, cause)
        }
        return { cause }
      }
    })()
    return {
      registered,
      stop: () => {
        stopped = true
        unlisten?.()
        unlisten = null
      },
    }
  }
}

export function createEmbeddingRuntimeService(
  deps: EmbeddingRuntimeServiceDeps,
): EmbeddingRuntimeService {
  return new EmbeddingRuntimeServiceImpl(deps)
}
