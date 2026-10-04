import { useQuery } from '@tanstack/react-query'
import { isWikiPath, wikiCopies, type WikiLanguage } from '@reflect/core'
import { useBridgeReady } from '@/hooks/use-bridge-ready.ts'
import { useWikiLanguages } from '@/hooks/use-wiki-languages.ts'
import { queryKeys } from '@/lib/query-client.ts'
import { useGraph } from '@/providers/graph-provider.tsx'

/** One language's copy of a wiki entry, or `path: null` where it has none. */
export interface WikiCopy {
  readonly language: WikiLanguage
  readonly path: string | null
}

/**
 * Every language's copy of the wiki entry at `path`, in settings order;
 * undefined while loading, and for a note outside the wiki. An index query, so
 * a translation created or deleted elsewhere shows up on the next refetch.
 */
export function useWikiCopies(path: string): readonly WikiCopy[] | undefined {
  const { graph } = useGraph()
  const bridgeReady = useBridgeReady()
  const languages = useWikiLanguages()
  const inWiki = isWikiPath(path, languages)
  const { data } = useQuery({
    queryKey: queryKeys.index.wikiCopies(graph?.root, path, languages),
    queryFn: () => wikiCopies(path, languages),
    enabled: bridgeReady && graph !== null && inWiki,
  })
  return inWiki ? data : undefined
}
