import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { isIndexProgressWorthShowing, type FinishedOperation, type Operation } from '@reflect/core'
import { useAppServices, useCoreServices } from '@/services/services-provider.tsx'
import { useServiceState } from '@/services/use-service-state.ts'

/** One piece of work in progress, as the activity tray lists it. */
export interface ActivityItem {
  readonly key: string
  readonly label: string
  readonly detail: string | null
  readonly progress: { readonly done: number; readonly total: number } | null
}

/** Everything the activity tray shows: work in progress, problems, and recent history. */
export interface Activity {
  readonly running: readonly ActivityItem[]
  readonly attention: readonly Operation[]
  readonly history: readonly FinishedOperation[]
}

/**
 * Background work gathered in one place, Arc-downloads style: the index pass
 * (once it is doing real work), the semantic index backfill, and background
 * operations while they run; any operation needing attention; and the
 * session's finished background operations.
 */
export function useActivity(): Activity {
  const { indexLifecycle, semanticSearch } = useCoreServices()
  const { operations } = useAppServices()
  const current = useServiceState(
    operations,
    useCallback(() => operations.getAll(), [operations]),
  )
  const history = useServiceState(
    operations,
    useCallback(() => operations.getHistory(), [operations]),
  )
  const index = useSyncExternalStore(
    indexLifecycle.subscribeFileProgress,
    indexLifecycle.fileProgress,
  )
  const semantic = useServiceState(semanticSearch, semanticSearch.getIndexProgress)
  return useMemo(() => {
    const running: ActivityItem[] = []
    if (index !== null && isIndexProgressWorthShowing(index)) {
      running.push({ key: 'index', label: 'Indexing notes', detail: null, progress: index })
    }
    if (semantic !== null && semantic.done < semantic.total) {
      running.push({
        key: 'semantic',
        label: 'Building the semantic index',
        detail: null,
        progress: semantic,
      })
    }
    for (const operation of current) {
      if (operation.background && operation.status === 'running') {
        running.push({
          key: `operation-${operation.id}`,
          label: operation.label,
          detail: operation.description,
          progress: operation.progress,
        })
      }
    }
    const attention = current.filter((operation) => operation.status !== 'running')
    return { running, attention, history }
  }, [current, history, index, semantic])
}

/** The share of known-size work done (0–1), or null when no item reports a size. */
export function activityFraction(items: readonly ActivityItem[]): number | null {
  let done = 0
  let total = 0
  for (const item of items) {
    if (item.progress !== null && item.progress.total > 0) {
      done += Math.min(item.progress.done, item.progress.total)
      total += item.progress.total
    }
  }
  return total === 0 ? null : done / total
}
