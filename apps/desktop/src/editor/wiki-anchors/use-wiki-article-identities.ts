import { useCallback, useEffect, useMemo, useState } from 'react'
import { readWikiArticle, resolveExistingWikiTarget, splitWikiLinkTarget } from '@reflect/core'
import { useGraph } from '@/providers/graph-provider.tsx'
import { todayIso } from '@/lib/dates.ts'

/** Resolve source aliases to graph paths; fragments remain distinct in the shared index. */
export function useWikiArticleIdentities(source: string): (title: string) => string | null {
  const graph = useGraph({ optional: true })?.graph ?? null
  const generation = graph?.generation ?? null
  const graphKey = graph?.root ?? null
  const namesKey = useMemo(
    () =>
      JSON.stringify(
        [
          ...new Set(
            readWikiArticle(source, todayIso())
              .references.filter((reference) => reference.kind === 'note')
              .map((reference) => splitWikiLinkTarget(reference.target).name),
          ),
        ].sort(),
      ),
    [source],
  )
  const [resolved, setResolved] = useState<{ key: string; values: ReadonlyMap<string, string> }>({
    key: '',
    values: new Map(),
  })
  const key = `${graphKey ?? ''}:${generation ?? ''}:${namesKey}`
  useEffect(() => {
    if (generation === null || graphKey === null) return
    let canceled = false
    const names = JSON.parse(namesKey) as string[]
    void Promise.all(
      names.map(async (name) => {
        try {
          const target = await resolveExistingWikiTarget(name, generation)
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
  }, [generation, graphKey, key, namesKey])
  return useCallback(
    (title: string) => (resolved.key === key ? (resolved.values.get(title) ?? null) : null),
    [key, resolved],
  )
}
