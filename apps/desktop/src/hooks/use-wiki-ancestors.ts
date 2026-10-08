import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { wikiAncestorIndexPaths, wikiAncestors, type WikiAncestor } from '@reflect/core'
import { useBridgeReady } from '@/hooks/use-bridge-ready.ts'
import { useWikiLanguages } from '@/hooks/use-wiki-languages.ts'
import { queryKeys } from '@/lib/query-client.ts'
import { useGraph } from '@/providers/graph-provider.tsx'

/**
 * The indexes above a wiki note: `none` where no index could sit above it
 * (outside the wiki, a root index), `loading` while the index is asked, then
 * the ones that exist, root first.
 */
export type WikiAncestorsState =
  | { readonly kind: 'none' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly ancestors: readonly WikiAncestor[] }

const NONE: WikiAncestorsState = { kind: 'none' }
const LOADING: WikiAncestorsState = { kind: 'loading' }

/**
 * The indexes above the wiki note at `path` (see `wikiAncestors`). Only a note
 * that could have one asks the index. An index query, so moving a note or
 * adding or deleting an index shows up on the next refetch.
 */
export function useWikiAncestors(path: string): WikiAncestorsState {
  const { graph } = useGraph()
  const bridgeReady = useBridgeReady()
  const languages = useWikiLanguages()
  const possible = useMemo(
    () => wikiAncestorIndexPaths(path, languages).length > 0,
    [path, languages],
  )
  const enabled = bridgeReady && graph !== null && possible
  const { data, isError } = useQuery({
    queryKey: queryKeys.index.wikiAncestors(graph?.root, path, languages),
    queryFn: () => wikiAncestors(path, languages),
    enabled,
  })
  // A lookup that can't run, or failed, shows no trail rather than holding its line.
  if (!enabled || isError) {
    return NONE
  }
  return data === undefined ? LOADING : { kind: 'ready', ancestors: data }
}
