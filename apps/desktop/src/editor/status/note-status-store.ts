import { useSyncExternalStore } from 'react'

/** A mounted note's live status, as the status corner reads it. */
export interface NoteStatus {
  /** Characters the reader sees (`countDisplayChars` over the live buffer). */
  readonly characters: number
}

interface Entry {
  readonly owner: symbol
  readonly status: NoteStatus
}

/**
 * Module-scope statuses keyed by graph-relative note path. Each publishing
 * pane owns its entry through an opaque token (the `outline-store.ts` rule), so
 * an unmount racing the next pane's mount for the same path never clears it.
 */
const entries = new Map<string, Entry>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) {
    listener()
  }
}

/** Publish (or replace) `owner`'s status for `path`. */
export function publishNoteStatus(path: string, owner: symbol, status: NoteStatus): void {
  entries.set(path, { owner, status })
  notify()
}

/** Remove `path`'s status, but only while `owner` still holds it. */
export function clearNoteStatus(path: string, owner: symbol): void {
  if (entries.get(path)?.owner !== owner) {
    return
  }
  entries.delete(path)
  notify()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The live status of `path`'s mounted editor, or null; a `null` path reads nothing. */
export function useNoteStatus(path: string | null): NoteStatus | null {
  const read = (): NoteStatus | null => (path === null ? null : (entries.get(path)?.status ?? null))
  return useSyncExternalStore(subscribe, read, read)
}
