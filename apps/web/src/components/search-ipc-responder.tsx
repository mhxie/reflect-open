import { useEffect } from 'react'
import { useCoreServices } from '@/services/services-provider.tsx'

/**
 * Answers `reflect search --mode semantic|hybrid` for the open graph (see
 * `search_ipc.rs`). Renders nothing; `SearchIpcService.start` serves the open
 * graph's socket from the main window, off mobile, so a CLI search finds the
 * app only when it can answer.
 */
export function SearchIpcResponder(): null {
  const { searchIpc } = useCoreServices()
  useEffect(() => searchIpc.start(), [searchIpc])
  return null
}
