import { z } from 'zod'
import { getBridge, type Unlisten } from '../ipc/bridge.ts'
import { call } from '../ipc/invoke.ts'
import { errorMessage } from '../errors.ts'
import { HIGHLIGHT_END, HIGHLIGHT_START } from '../indexing/search.ts'
import { embedStatus } from './commands.ts'
import { retrieve } from './retrieve.ts'

/**
 * Search for the `reflect` CLI (`search_ipc.rs`): the CLI's semantic and
 * hybrid modes reach the running app over a socket, and the main window
 * answers with {@link retrieve}, the ranking ⌘K and the AI tools use.
 */

const REQUEST_EVENT = 'search-ipc:request'

export const searchIpcRequestSchema = z.object({
  id: z.number().int().positive(),
  query: z.string(),
  mode: z.enum(['lexical', 'semantic', 'hybrid']),
  limit: z.number().int().positive(),
})
export type SearchIpcRequest = z.infer<typeof searchIpcRequestSchema>

export interface SearchIpcResult {
  readonly path: string
  readonly title: string
  readonly snippet: string
  readonly score: number
}

/** What the CLI receives: the mode that actually ran, or why none could. */
export type SearchIpcAnswer =
  | { readonly mode: SearchIpcRequest['mode']; readonly results: SearchIpcResult[] }
  | { readonly error: string }

/** Serve the open graph's search on its socket (a no-op while already serving it). */
export async function startSearchIpc(): Promise<void> {
  await call('search_ipc_start', {}, z.null())
}

/** Close the socket; requests still waiting get an error. */
export async function stopSearchIpc(): Promise<void> {
  await call('search_ipc_stop', {}, z.null())
}

export async function respondSearchIpc(id: number, answer: SearchIpcAnswer): Promise<void> {
  await call('search_ipc_respond', { id, answer }, z.null())
}

/** Requests the CLI sent through the socket, for the main window to answer. */
export function subscribeSearchIpcRequests(
  handler: (request: SearchIpcRequest) => void,
): Promise<Unlisten> {
  return getBridge().listen(REQUEST_EVENT, (payload) => {
    const parsed = searchIpcRequestSchema.safeParse(payload)
    if (parsed.success) {
      handler(parsed.data)
    } else {
      console.error('invalid search-ipc:request payload:', parsed.error)
    }
  })
}

/**
 * Answer one CLI request. Semantic modes need semantic search on and its model
 * loaded; otherwise the answer is lexical and says so, so a caller labels its
 * results honestly. Private notes are invisible through the CLI, so they are
 * dropped outright, not just stripped of content.
 */
export async function answerSearchIpcRequest(
  request: SearchIpcRequest,
  semanticSearchEnabled: boolean,
): Promise<SearchIpcAnswer> {
  try {
    const semanticReady = semanticSearchEnabled && (await embedStatus()).status === 'ready'
    const mode = semanticReady ? request.mode : 'lexical'
    const hits = await retrieve(request.query, {
      mode,
      limit: request.limit,
      excludePrivateContent: true,
    })
    return {
      mode,
      results: hits
        .filter((hit) => !hit.isPrivate && hit.hasDeviceOnlyContent !== true)
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
