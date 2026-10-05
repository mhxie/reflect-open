import { useEffect, useRef } from 'react'
import {
  answerSearchIpcRequest,
  errorMessage,
  respondSearchIpc,
  startSearchIpc,
  stopSearchIpc,
  subscribeSearchIpcRequests,
} from '@reflect/core'
import { isMobileSurface } from '@/lib/platform-surface.ts'
import { isMainWindow } from '@/lib/windows/window-role.ts'
import { useGraph } from '@/providers/graph-provider.tsx'
import { useSettings } from '@/providers/settings-provider.tsx'

/**
 * Answers `reflect search --mode semantic|hybrid` for the open graph (see
 * `search_ipc.rs`). Renders nothing; the main window owns the socket while a
 * graph is open, so a CLI search finds the app only when it can answer.
 */
export function SearchIpcResponder(): null {
  const { graph } = useGraph()
  const { settings } = useSettings()
  const root = graph?.root ?? null
  // Read per request, so toggling semantic search applies without restarting.
  const semanticSearchEnabled = useRef(settings.semanticSearchEnabled)
  semanticSearchEnabled.current = settings.semanticSearchEnabled

  useEffect(() => {
    if (root === null || !isMainWindow() || isMobileSurface()) {
      return
    }
    let active = true
    const unlisten = subscribeSearchIpcRequests((request) => {
      void (async () => {
        const answer = await answerSearchIpcRequest(request, semanticSearchEnabled.current)
        if (active) {
          await respondSearchIpc(request.id, answer)
        }
      })().catch((cause) => {
        console.error('answering a CLI search failed:', errorMessage(cause))
      })
    })
    // A graph whose path is too long for a socket, or another app already
    // serving it, just leaves search in-app: nothing to surface.
    void unlisten
      .then(() => (active ? startSearchIpc() : undefined))
      .catch((cause) => {
        console.warn('search for the CLI is unavailable:', errorMessage(cause))
      })
    return () => {
      active = false
      // A subscription that failed has nothing to stop (its failure was
      // already reported above).
      void unlisten.then((stop) => stop()).catch(() => {})
      void stopSearchIpc().catch(() => {})
    }
  }, [root])

  return null
}
