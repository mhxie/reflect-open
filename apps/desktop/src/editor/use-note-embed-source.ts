import { useCallback, useEffect, useState } from 'react'
import { resolveExistingWikiTarget, subscribeOwnWrites, type FileChange } from '@reflect/core'
import { readExistingNoteSource } from '@/lib/read-existing-note-source.ts'
import { useFileChanges } from '@/lib/use-file-changes.ts'

/** Deepest chain of ancestors an embed still reads; deeper ones show the depth limit. */
export const MAX_NOTE_EMBED_DEPTH = 4

/** Which embed to read, and from where. */
export interface NoteEmbedSourceOptions {
  /** The embed's wiki target (`Note` or `Note#Heading`). */
  readonly target: string
  /** The note containing the embed, for relative resolution. */
  readonly sourcePath: string
  readonly generation: number | null
  readonly graphKey: string | null
  /** Resolved paths of the notes above this embed, for cycle and depth checks. */
  readonly ancestors: readonly string[]
  readonly enabled: boolean
}

/** An embed's source: its resolved path and contents, or why it can't be shown. */
export type NoteEmbedSource =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly path: string; readonly source: string }
  | { readonly kind: 'missing' | 'ambiguous' | 'unavailable' | 'cycle' | 'limit' }

interface SourceSnapshot {
  readonly key: string
  readonly result: NoteEmbedSource
}

const LOADING: NoteEmbedSource = { kind: 'loading' }

/** Read-only source loading pinned to a graph; disabled, unmounted, or replaced reads retire. */
export function useNoteEmbedSource(options: NoteEmbedSourceOptions): {
  readonly source: NoteEmbedSource
  readonly reload: () => void
} {
  const { target, sourcePath, generation, graphKey, ancestors, enabled } = options
  const key = JSON.stringify([graphKey, generation, target, sourcePath, ancestors])
  const [revision, setRevision] = useState(0)
  const [snapshot, setSnapshot] = useState<SourceSnapshot | null>(null)
  // A refresh keeps showing the last result for the same embed, so an
  // expanded reader (and its outline entries) survives the re-read.
  const source = snapshot?.key === key ? snapshot.result : LOADING
  const watchPath =
    snapshot?.key === key && snapshot.result.kind === 'ready' ? snapshot.result.path : null
  const reload = useCallback(() => setRevision((value) => value + 1), [])

  useEffect(() => {
    if (!enabled) return
    let active = true
    const publish = (result: NoteEmbedSource): void => {
      if (active) setSnapshot({ key, result })
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

  const sourceKind = source.kind
  const onFileChanges = useCallback(
    (changes: FileChange[]) => {
      if (!enabled) return
      if (
        watchPath !== null
          ? changes.some((change) => change.path === watchPath)
          : sourceKind !== 'cycle' &&
            sourceKind !== 'limit' &&
            changes.some((change) => change.path.endsWith('.md'))
      ) {
        reload()
      }
    },
    [enabled, sourceKind, watchPath, reload],
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
