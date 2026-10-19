import { z } from 'zod'
import { errorMessage } from '../errors.ts'
import type { GraphRole, GraphSession } from '../graph/graph-session.ts'
import { HIGHLIGHT_END, HIGHLIGHT_START } from '../indexing/search.ts'
import type { IpcBridgeService } from '../ipc/ipc-service.ts'
import type { LoggerService } from '../ports/logger-service.ts'
import { isMobilePlatform, type PlatformFacts } from '../ports/platform-facts.ts'
import { isPrivateNote } from '../privacy/privacy-service.ts'
import type { SettingsService } from '../settings/settings-service.ts'
import type { Unlisten } from '../unlisten.ts'
import type { EmbeddingRuntimeService } from './embedding-runtime-service.ts'
import type { RetrievalService } from './retrieval-service.ts'

/**
 * Search for the `reflect` CLI (`search_ipc.rs`): the CLI's semantic and
 * hybrid modes reach the running app over a socket, and the main window
 * answers with `RetrievalService.retrieve`, the ranking ⌘K and the AI tools use.
 */

const REQUEST_EVENT = 'search-ipc:request'

const voidSchema = z.null()

export const searchIpcRequestSchema = z.object({
  id: z.number().int().positive(),
  query: z.string(),
  mode: z.enum(['lexical', 'semantic', 'hybrid']),
  limit: z.number().int().positive(),
})

/**
 * One search the CLI sent through the socket.
 */
export type SearchIpcRequest = z.infer<typeof searchIpcRequestSchema>

/**
 * One result as the CLI prints it.
 */
export interface SearchIpcResult {
  readonly path: string
  readonly title: string
  readonly snippet: string
  readonly score: number
}

/**
 * What the CLI receives: the mode that actually ran, or why none could.
 */
export type SearchIpcAnswer =
  | { readonly mode: SearchIpcRequest['mode']; readonly results: SearchIpcResult[] }
  | { readonly error: string }

/**
 * Hits fetched per requested result: private hits are dropped after ranking,
 * so fetching only `limit` would hand the CLI short pages in a graph with many
 * private notes.
 */
const PRIVATE_OVERFETCH = 2

/**
 * The open graph as {@link SearchIpcService} reads it; a `GraphSessionService` is one.
 */
export interface SearchIpcGraphSource {
  getState: () => { readonly session: GraphSession | null }
  subscribe: (listener: () => void) => Unlisten
}

/**
 * Answers `reflect search --mode semantic|hybrid` for the open graph.
 */
export interface SearchIpcService {
  /**
   * Serve the open graph's search on its socket until the returned function
   * is called: the main window, off mobile, owns the socket while a graph is
   * open, so a CLI search finds the app only when it can answer. Each request
   * is answered with {@link SearchIpcService.answer}; a graph switch closes
   * the old socket and serves the new graph. A graph whose path is too long
   * for a socket, or another app already serving it, just leaves search
   * in-app (logged, nothing to surface).
   */
  start(): Unlisten
  /**
   * Answer one CLI request. Semantic modes need semantic search on and its
   * model loaded; otherwise the answer is lexical and says so, so a caller
   * labels its results honestly. Private notes are invisible through the CLI
   * (flagged, device-only, or inside one of the open graph's local-only
   * folders), so they are dropped outright, not just stripped of content; the
   * ranking over-fetches so the drop still leaves up to `limit` results. A
   * failure is an `{ error }` answer, never a rejection.
   */
  answer(request: SearchIpcRequest): Promise<SearchIpcAnswer>
}

export interface SearchIpcServiceDeps {
  readonly ipc: IpcBridgeService
  readonly retrieval: RetrievalService
  readonly embeddingRuntime: EmbeddingRuntimeService
  readonly settings: SettingsService
  readonly platform: PlatformFacts
  readonly role: GraphRole
  readonly graphSession: SearchIpcGraphSource
  readonly logger: LoggerService
}

class SearchIpcServiceImpl implements SearchIpcService {
  readonly #deps: SearchIpcServiceDeps

  constructor(deps: SearchIpcServiceDeps) {
    this.#deps = deps
  }

  start(): Unlisten {
    const { graphSession, platform, role } = this.#deps
    if (role !== 'main' || isMobilePlatform(platform.appPlatform) || platform.surface.mobileApp) {
      return () => {}
    }
    let served: string | null = null
    let stopServing: Unlisten | null = null
    const react = (): void => {
      const root = graphSession.getState().session?.root ?? null
      if (root === served) {
        return
      }
      served = root
      stopServing?.()
      stopServing = root === null ? null : this.#serve()
    }
    const unlisten = graphSession.subscribe(react)
    react()
    return () => {
      unlisten()
      stopServing?.()
      stopServing = null
      served = null
    }
  }

  async answer(request: SearchIpcRequest): Promise<SearchIpcAnswer> {
    const { retrieval, embeddingRuntime, settings, graphSession } = this.#deps
    const localOnly = graphSession.getState().session?.localOnly ?? null
    try {
      const semanticReady =
        settings.get().semanticSearchEnabled && (await embeddingRuntime.status()).status === 'ready'
      const mode = semanticReady ? request.mode : 'lexical'
      const hits = await retrieval.retrieve(request.query, {
        mode,
        limit: request.limit * PRIVATE_OVERFETCH,
        excludePrivateContent: true,
      })
      return {
        mode,
        results: hits
          .filter((hit) => localOnly !== null && !isPrivateNote(localOnly, hit))
          .slice(0, request.limit)
          .map((hit) => ({
            path: hit.path,
            title: hit.title,
            snippet: hit.snippet.replaceAll(HIGHLIGHT_START, '').replaceAll(HIGHLIGHT_END, ''),
            score: hit.score,
          })),
      }
    } catch (cause) {
      return { error: errorMessage(cause) }
    }
  }

  /**
   * Answer requests and serve the open graph's socket until the returned function is called.
   */
  #serve(): Unlisten {
    const { ipc, logger } = this.#deps
    let active = true
    const listening = ipc.listen(REQUEST_EVENT, (payload) => {
      const parsed = searchIpcRequestSchema.safeParse(payload)
      if (!parsed.success) {
        logger.error(`invalid ${REQUEST_EVENT} payload:`, parsed.error)
        return
      }
      void this.#respond(parsed.data, () => active)
    })
    void listening
      .then(async () => {
        if (active) {
          await ipc.call('search_ipc_start', {}, voidSchema)
        }
      })
      .catch((cause: unknown) => {
        logger.warn('search for the CLI is unavailable:', errorMessage(cause))
      })
    return () => {
      active = false
      // A subscription that failed has nothing to stop (its failure was
      // already reported above).
      void listening.then((unlisten) => unlisten()).catch(() => {})
      void ipc.call('search_ipc_stop', {}, voidSchema).catch(() => {})
    }
  }

  async #respond(request: SearchIpcRequest, isActive: () => boolean): Promise<void> {
    try {
      const answer = await this.answer(request)
      if (isActive()) {
        await this.#deps.ipc.call('search_ipc_respond', { id: request.id, answer }, voidSchema)
      }
    } catch (cause) {
      this.#deps.logger.error('answering a CLI search failed:', errorMessage(cause))
    }
  }
}

export function createSearchIpcService(deps: SearchIpcServiceDeps): SearchIpcService {
  return new SearchIpcServiceImpl(deps)
}
