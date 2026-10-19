import { useQuery } from '@tanstack/react-query'
import { hasUnreadableLock, isLocalOnlyPath, parseNote } from '@reflect/core'
import { useLocalOnlyFolders } from '@/hooks/use-local-only-folders.ts'
import { queryKeys } from '@/lib/query-client.ts'
import { useGraph } from '@/providers/graph-provider.tsx'
import { useCoreServices } from '@/services/services-provider.tsx'

/**
 * Whether a locked note's frontmatter can't be read (`hasUnreadableLock`):
 * the shared classifier treats such a note as locked everywhere, and its Lock
 * control must say so rather than offer a toggle. The index row only carries
 * `isPrivate` (which such a note always sets), so the source is parsed for
 * private rows alone; the query lives under the index keys, so every index
 * change refreshes it.
 */
export function useUnreadableFrontmatter(path: string, isPrivate: boolean): boolean {
  const { graph } = useGraph()
  const { noteDocuments } = useCoreServices()
  const localOnly = useLocalOnlyFolders()
  const { data } = useQuery({
    queryKey: queryKeys.index.noteFrontmatterPrivacy(graph?.root, path),
    queryFn: async () =>
      hasUnreadableLock(parseNote({ path, source: await noteDocuments.readSource(path) })),
    enabled: graph !== null && isPrivate && !isLocalOnlyPath(localOnly, path),
  })
  return isPrivate && data === true
}
