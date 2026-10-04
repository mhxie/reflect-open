import { useQuery } from '@tanstack/react-query'
import { isLocalOnlyPath, parseNote } from '@reflect/core'
import { useBridgeReady } from '@/hooks/use-bridge-ready.ts'
import { readNoteSource } from '@/lib/note-frontmatter.ts'
import { hasUnreadableLock } from '@/lib/note-private.ts'
import { queryKeys } from '@/lib/query-client.ts'
import { useGraph } from '@/providers/graph-provider.tsx'

/**
 * Whether a locked note's frontmatter can't be read ({@link hasUnreadableLock}):
 * the shared classifier treats such a note as locked everywhere, and its Lock
 * control must say so rather than offer a toggle. The index row only carries
 * `isPrivate` (which such a note always sets), so the source is parsed for
 * private rows alone; the query lives under the index keys, so every index
 * change refreshes it.
 */
export function useUnreadableFrontmatter(path: string, isPrivate: boolean): boolean {
  const { graph } = useGraph()
  const bridgeReady = useBridgeReady()
  const { data } = useQuery({
    queryKey: queryKeys.index.noteFrontmatterPrivacy(graph?.root, path),
    queryFn: async () => hasUnreadableLock(parseNote({ path, source: await readNoteSource(path) })),
    enabled: bridgeReady && graph !== null && isPrivate && !isLocalOnlyPath(path),
  })
  return isPrivate && data === true
}
