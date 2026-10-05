import { useCallback, useEffect, useState } from 'react'
import { resolveExistingWikiTarget, subscribeOwnWrites, type FileChange } from '@reflect/core'
import { readExistingNoteSource } from '@/lib/read-existing-note-source.ts'
import { useFileChanges } from '@/lib/use-file-changes.ts'

export const MAX_NOTE_EMBED_DEPTH = 4

export interface NoteEmbedSourceOptions {
  readonly target: string
  readonly sourcePath: string
  readonly generation: number | null
  readonly graphKey: string | null
  readonly ancestors: readonly string[]
  readonly enabled: boolean
}

export type NoteEmbedSource =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly path: string; readonly source: string }
  | { readonly kind: 'missing' | 'ambiguous' | 'unavailable' | 'cycle' | 'limit' }

interface SourceSnapshot {
  readonly key: string
  readonly revision: number
  readonly result: NoteEmbedSource
}

/** Read-only source loading pinned to a graph; disabled, unmounted, or replaced reads retire. */
export function useNoteEmbedSource(options: NoteEmbedSourceOptions): {
  readonly source: NoteEmbedSource
  readonly reload: () => void
} {
  const { target, sourcePath, generation, graphKey, ancestors, enabled } = options
  const key = JSON.stringify([graphKey, generation, target, sourcePath, ancestors])
  const [revision, setRevision] = useState(0)
  const [snapshot, setSnapshot] = useState<SourceSnapshot | null>(null)
  const source: NoteEmbedSource =
    snapshot?.key === key && snapshot.revision === revision ? snapshot.result : { kind: 'loading' }
  const watchPath =
    snapshot?.key === key && snapshot.result.kind === 'ready' ? snapshot.result.path : null
  const reload = useCallback(() => setRevision((value) => value + 1), [])

  useEffect(() => {
    if (!enabled) return
    let active = true
    const publish = (result: NoteEmbedSource): void => {
      if (active) setSnapshot({ key, revision, result })
    }
    async function load(): Promise<void> {
      if (generation === null || graphKey === null) {
        publish({ kind: 'unavailable' })
        return
      }
      if (ancestors.length > MAX_NOTE_EMBED_DEPTH) {
        publish({ kind: 'limit' })
        return
      }
      try {
        const result = await resolveExistingWikiTarget(target, generation, sourcePath)
        if (!active) return
        if (result.kind !== 'resolved') {
          publish({ kind: result.kind })
          return
        }
        if (ancestors.includes(result.path)) {
          publish({ kind: 'cycle' })
          return
        }
        const contents = await readExistingNoteSource(result.path, generation)
        publish({ kind: 'ready', path: result.path, source: contents })
      } catch {
        publish({ kind: 'unavailable' })
      }
    }
    void load()
    return () => {
      active = false
    }
  }, [enabled, key, revision, generation, graphKey, target, sourcePath, ancestors])

  const onFileChanges = useCallback(
    (changes: FileChange[]) => {
      if (!enabled) return
      if (
        watchPath !== null
          ? changes.some((change) => change.path === watchPath)
          : source.kind !== 'cycle' &&
            source.kind !== 'limit' &&
            changes.some((change) => change.path.endsWith('.md'))
      ) {
        reload()
      }
    },
    [enabled, source, watchPath, reload],
  )
  useFileChanges(enabled ? onFileChanges : null)
  useEffect(() => {
    if (!enabled || watchPath === null) return
    return subscribeOwnWrites((path) => {
      if (path === watchPath) reload()
    })
  }, [enabled, watchPath, reload])
  return { source, reload }
}
