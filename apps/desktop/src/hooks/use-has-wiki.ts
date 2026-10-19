import { useQuery } from '@tanstack/react-query'
import { wikiSourceLanguage } from '@reflect/core'
import { useWikiLanguages } from '@/hooks/use-wiki-languages.ts'
import { queryKeys } from '@/lib/query-client.ts'
import { useGraph } from '@/providers/graph-provider.tsx'
import { useCoreServices } from '@/services/services-provider.tsx'

/**
 * Whether the open graph has a wiki — any note in the source language's
 * folder. False until the index answers, so the sidebar's Wiki row appears
 * only for graphs that use it.
 */
export function useHasWiki(): boolean {
  const { graph } = useGraph()
  const { wiki } = useCoreServices()
  const languages = useWikiLanguages()
  const { data } = useQuery({
    queryKey: queryKeys.index.hasWiki(graph?.root, wikiSourceLanguage(languages).folder),
    queryFn: () => wiki.hasEntries(languages),
    enabled: graph !== null,
  })
  return data === true
}
