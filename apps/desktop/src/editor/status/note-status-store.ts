import { useSyncExternalStore } from 'react'
import type { NoteState } from '@reflect/core'
import type { NoteProtection } from './note-protection.ts'

/** A note identity within the open graph's file session. */
export interface NoteStatusScope {
  readonly generation: number
  readonly path: string
}

/** A mounted note's live status, as note indicators and the status bar read it. */
export interface NoteStatus {
  /** Characters the reader sees (`countDisplayChars` over the live buffer). */
  readonly characters: number
  /** The same count over the editor's selection; 0 when nothing is selected. */
  readonly selectedCharacters: number
  /** When this pane last edited the note (epoch ms), ahead of the index. */
  readonly editedAt: number | null
  /** Explicit privacy and edit gates from the live session. */
  readonly state: NoteState
  /** Why editing is protected and the recovery offered by this exact pane. */
  readonly protection: NoteProtection | null
}

interface Entry {
  readonly owner: symbol
  readonly status: NoteStatus
}

/** Each pane owns its entry; a previous graph or pane cannot clear its successor. */
const entries = new Map<number, Map<string, Entry>>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) {
    listener()
  }
}

/** Publish scoped status; recovery callbacks expire when their entry is replaced or cleared. */
export function publishNoteStatus(scope: NoteStatusScope, owner: symbol, status: NoteStatus): void {
  let generation = entries.get(scope.generation)
  if (generation === undefined) {
    generation = new Map()
    entries.set(scope.generation, generation)
  }
  const protection = status.protection
  if (protection?.kind === 'save-blocked' || protection?.kind === 'external-change') {
    function guardRecovery(callback: () => void): () => void {
      return () => {
        const entry = entries.get(scope.generation)?.get(scope.path)
        if (entry?.owner === owner && entry.status.protection === guarded) {
          callback()
        }
      }
    }
    const guarded: NoteProtection =
      protection.kind === 'save-blocked'
        ? { ...protection, retrySave: guardRecovery(protection.retrySave) }
        : {
            ...protection,
            keepMine: guardRecovery(protection.keepMine),
            loadTheirs: guardRecovery(protection.loadTheirs),
          }
    generation.set(scope.path, { owner, status: { ...status, protection: guarded } })
  } else {
    generation.set(scope.path, { owner, status })
  }
  notify()
}

/** Remove the scoped status only while `owner` still holds it. */
export function clearNoteStatus(scope: NoteStatusScope, owner: symbol): void {
  const generation = entries.get(scope.generation)
  if (generation?.get(scope.path)?.owner !== owner) {
    return
  }
  generation.delete(scope.path)
  if (generation.size === 0) {
    entries.delete(scope.generation)
  }
  notify()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The scoped mounted editor's live status, or null when none is published. */
export function useNoteStatus(scope: NoteStatusScope | null): NoteStatus | null {
  const read = (): NoteStatus | null =>
    scope === null ? null : (entries.get(scope.generation)?.get(scope.path)?.status ?? null)
  return useSyncExternalStore(subscribe, read, read)
}
