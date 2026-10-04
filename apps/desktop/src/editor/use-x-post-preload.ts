import { collectImages, parseXPostId } from '@meowdown/markdown'
import { sleep } from '@ocavue/utils'
import { useQueries } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { xPostQueryOptions } from '@/editor/use-x-post-resolver.ts'
import { queryClient } from '@/lib/query-client.ts'
import { useGraph } from '@/providers/graph-provider.tsx'

// Longest wait before mounting anyway; cold-start archive reads measured up to 258 ms.
const PRELOAD_BUDGET_MS = 300

/**
 * What the note's privacy lets the preload do: fetch its posts (`public`),
 * nothing (`private`), or wait without fetching until the verdict lands
 * (`pending`).
 */
export type XPostPreloadPrivacy = 'public' | 'private' | 'pending'

/**
 * Whether an editor mounted now for `markdown` renders its X post cards in the
 * first frame: every post is loaded, or the wait ran out. `null` means there
 * is no editor content yet. A note without X posts is ready at once. A private
 * note preloads nothing (a lookup fetches the post and writes its archive)
 * and is ready at once; while its privacy is pending nothing is fetched and
 * the same wait runs, so a public note whose verdict lands within it still
 * preloads.
 */
export function useXPostPreload(markdown: string | null, privacy: XPostPreloadPrivacy): boolean {
  const generation = useGraph({ optional: true })?.graph?.generation ?? null
  const postIds = useMemo(() => {
    const ids = new Set<string>()
    for (const url of markdown === null ? [] : collectImages(markdown)) {
      const id = parseXPostId(url)
      if (id) ids.add(id)
    }
    return [...ids]
  }, [markdown])
  const queries = useMemo(
    () =>
      generation === null || privacy !== 'public'
        ? []
        : postIds.map((id) => xPostQueryOptions(generation, id)),
    [postIds, generation, privacy],
  )
  // The resolver reads the shared client, so the preload must fill that one.
  const loaded = useQueries(
    {
      queries,
      combine: (results) => results.every((result) => !result.isPending),
    },
    queryClient,
  )
  const settled = postIds.length === 0 || privacy === 'private' || (privacy === 'public' && loaded)
  const [expiredFor, setExpiredFor] = useState<string | null>(null)

  useEffect(() => {
    if (markdown === null || settled) return
    let active = true
    void sleep(PRELOAD_BUDGET_MS).then(() => {
      if (active) setExpiredFor(markdown)
    })
    return () => {
      active = false
    }
  }, [markdown, settled])

  return markdown !== null && (settled || expiredFor === markdown)
}
