import { useSyncExternalStore } from 'react'
import type { WikiArticleIndex } from '@reflect/core'

/** The live source projection and view controls of one mounted note. */
export interface NoteArticle {
  readonly index: WikiArticleIndex
  readonly showRanges: boolean
  readonly toggleRanges: () => void
  readonly markSelection: (from: number, to: number) => void
  readonly selectionClaims: (from: number, to: number) => readonly string[]
  readonly adjustSelection: (id: string, from: number, to: number) => void
  readonly copySource: (from: number, to: number) => Promise<void>
}

interface Entry {
  readonly owner: symbol
  readonly article: NoteArticle
}

const entries = new Map<string, Entry>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

/** Publish only a mounted editor's current projection. */
export function publishNoteArticle(path: string, owner: symbol, article: NoteArticle): void {
  entries.set(path, { owner, article })
  notify()
}

/** A stale pane cannot remove the next pane's article. */
export function clearNoteArticle(path: string, owner: symbol): void {
  if (entries.get(path)?.owner !== owner) return
  entries.delete(path)
  notify()
}

/** Read the current editor action without retaining stale source positions. */
export function noteArticleFor(path: string): NoteArticle | null {
  return entries.get(path)?.article ?? null
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The note status bar observes the same projection used by the editor. */
export function useNoteArticle(path: string | null): NoteArticle | null {
  const read = (): NoteArticle | null => (path === null ? null : noteArticleFor(path))
  return useSyncExternalStore(subscribe, read, read)
}
