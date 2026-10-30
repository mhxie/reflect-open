import { useCallback, useEffect, useMemo, useState } from 'react'
import { readWikiArticle, splitWikiLinkTarget } from '@reflect/core'
import { getIsoToday } from '@reflect/utils'
import { useMaybeGraph } from '@/providers/graph-provider.tsx'
import { useCoreServices } from '@/services/services-provider.tsx'

/**
 * Resolve source aliases to graph paths; fragments remain distinct in the shared index.
 */
export function useWikiArticleIdentities(source: string): (title: string) => string | null {
  const { noteLinkResolver } = useCoreServices()
  const graph = useMaybeGraph()?.graph ?? null
  const generation = graph?.generation ?? null
  const graphKey = graph?.root ?? null
  const namesKey = useMemo(() => {
    return JSON.stringify(
      [
        ...new Set(
          readWikiArticle(source, getIsoToday())
            .references.filter((reference) => reference.kind === 'note')
            .map((reference) => splitWikiLinkTarget(reference.target).name),
        ),
      ].sort(),
    )
  }, [source])
  const [resolved, setResolved] = useState<{ key: string; values: ReadonlyMap<string, string> }>(
    () => ({ key: '', values: new Map() }),
  )
  const key = `${graphKey ?? ''}:${generation ?? ''}:${namesKey}`
  useEffect(() => {
    if (generation === null || graphKey === null) return
    let canceled = false
    const names = JSON.parse(namesKey) as string[]
    void Promise.all(
      names.map(async (name) => {
        try {
          const target = await noteLinkResolver.resolveWikiTarget(name, generation)
          return target.kind === 'resolved' ? ([name, target.path] as const) : null
        } catch {
          return null
        }
      }),
    ).then((values) => {
      if (!canceled) setResolved({ key, values: new Map(values.filter((value) => value !== null)) })
    })
    return () => {
      canceled = true
    }
  }, [generation, graphKey, key, namesKey, noteLinkResolver])
  return useCallback(
    (title: string) => (resolved.key === key ? (resolved.values.get(title) ?? null) : null),
    [key, resolved],
  )
}
