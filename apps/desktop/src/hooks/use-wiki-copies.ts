import { useQuery } from '@tanstack/react-query'
import { isWikiPath, type WikiCopy } from '@reflect/core'
import { useWikiLanguages } from '@/hooks/use-wiki-languages.ts'
import { queryKeys } from '@/lib/query-client.ts'
import { useGraph } from '@/providers/graph-provider.tsx'
import { useCoreServices } from '@/services/services-provider.tsx'

/**
 * Every language's copy of the wiki entry at `path`, in settings order;
 * undefined while loading, and for a note outside the wiki. An index query, so
 * a translation created or deleted elsewhere shows up on the next refetch.
 */
export function useWikiCopies(path: string): readonly WikiCopy[] | undefined {
  const { graph } = useGraph()
  const { wiki } = useCoreServices()
  const languages = useWikiLanguages()
  const inWiki = isWikiPath(path, languages)
  const { data } = useQuery({
    queryKey: queryKeys.index.wikiCopies(graph?.root, path, languages),
    queryFn: () => wiki.copies(path, languages),
    enabled: graph !== null && inWiki,
  })
  return inWiki ? data : undefined
}
