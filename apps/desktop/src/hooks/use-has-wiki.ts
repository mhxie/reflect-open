import { useQuery } from '@tanstack/react-query'
import { hasWikiEntries, wikiSourceLanguage } from '@reflect/core'
import { useBridgeReady } from '@/hooks/use-bridge-ready.ts'
import { useWikiLanguages } from '@/hooks/use-wiki-languages.ts'
import { queryKeys } from '@/lib/query-client.ts'
import { useGraph } from '@/providers/graph-provider.tsx'

/**
 * Whether the open graph has a wiki — any note in the source language's
 * folder. False until the index answers, so the sidebar's Wiki row appears
 * only for graphs that use it.
 */
export function useHasWiki(): boolean {
  const { graph } = useGraph()
  const bridgeReady = useBridgeReady()
  const languages = useWikiLanguages()
  const { data } = useQuery({
    queryKey: queryKeys.index.hasWiki(graph?.root, wikiSourceLanguage(languages).folder),
    queryFn: () => hasWikiEntries(languages),
    enabled: bridgeReady && graph !== null,
  })
  return data === true
}
