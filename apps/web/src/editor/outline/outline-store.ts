import { useSyncExternalStore } from 'react'
import type { OutlineHeading } from './outline-headings.ts'

/** A mounted note editor's outline, as the sidebar and heading picker read it. */
export interface NoteOutline {
  readonly headings: readonly OutlineHeading[]
  /**
   * Index into {@link headings} of the section the reader is in — the last
   * heading scrolled to the top of the note — or null above the first one.
   */
  readonly activeIndex: number | null
  /**
   * Jump to `headings[index]`: scroll it to the top of the note, put the caret
   * at its start, and focus the editor. A no-op for an index the outline no
   * longer has.
   */
  readonly reveal: (index: number) => void
}

interface Entry {
  readonly owner: symbol
  readonly outline: NoteOutline
}

/**
 * Module-scope outlines keyed by graph-relative note path, in the external-store
 * shape of `formatting-toolbar-store.ts`. Each publishing bridge owns its entry
 * through an opaque token, so an unmount racing the next editor's mount for the
 * same path can never clear the live outline (the `editor-handle-registry.ts`
 * rule).
 */
const entries = new Map<string, Entry>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) {
    listener()
  }
}

/** Publish (or replace) `owner`'s outline for `path`. */
export function publishNoteOutline(path: string, owner: symbol, outline: NoteOutline): void {
  entries.set(path, { owner, outline })
  notify()
}

/** Remove `path`'s outline, but only while `owner` still holds it. */
export function clearNoteOutline(path: string, owner: symbol): void {
  if (entries.get(path)?.owner !== owner) {
    return
  }
  entries.delete(path)
  notify()
}

/** The outline of `path`'s mounted editor, or null when none publishes one. */
export function noteOutlineFor(path: string): NoteOutline | null {
  return entries.get(path)?.outline ?? null
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** {@link noteOutlineFor} as reactive state; `null` path reads nothing. */
export function useNoteOutline(path: string | null): NoteOutline | null {
  const read = (): NoteOutline | null => (path === null ? null : noteOutlineFor(path))
  return useSyncExternalStore(subscribe, read, read)
}
