import { useQuery } from '@tanstack/react-query'
import { frontmatterPrivacy, isLocalOnlyPath } from '@reflect/core'
import { useBridgeReady } from '@/hooks/use-bridge-ready.ts'
import { readNoteSource } from '@/lib/note-frontmatter.ts'
import { queryKeys } from '@/lib/query-client.ts'
import { useGraph } from '@/providers/graph-provider.tsx'

/**
 * Whether a note's frontmatter can't be read: the shared classifier treats
 * such a note as locked everywhere, and its Lock control must say so rather
 * than offer a toggle. The index row only carries `isPrivate` (which an
 * unreadable note always sets), so the source is classified for private rows
 * alone; the query lives under the index keys, so every index change
 * refreshes it.
 */
export function useUnreadableFrontmatter(path: string, isPrivate: boolean): boolean {
  const { graph } = useGraph()
  const bridgeReady = useBridgeReady()
  const { data } = useQuery({
    queryKey: queryKeys.index.noteFrontmatterPrivacy(graph?.root, path),
    queryFn: async () => frontmatterPrivacy(await readNoteSource(path)).kind,
    enabled: bridgeReady && graph !== null && isPrivate && !isLocalOnlyPath(path),
  })
  return isPrivate && data === 'unreadable'
}
