import { z } from 'zod'
import { getBridge, type Unlisten } from '../ipc/bridge.ts'

/** Pull displacement events and move-healing suppression for their graph session. */

/** Event name the pull emits for each entry it left moved aside. */
export const NOTE_DISPLACED_EVENT = 'note:displaced'

const noteDisplacedSchema = z.object({
  generation: z.number().int().nonnegative(),
  from: z.string(),
  to: z.string(),
  /** The moved note is locked (or its frontmatter can't be read). */
  keptOut: z.boolean(),
})

/** One entry a pull moved aside: graph-relative `from` → `to`. */
export type NoteDisplacement = z.infer<typeof noteDisplacedSchema>

/** Subscribe to entries pulls move aside. */
export function subscribeNoteDisplaced(
  handler: (displacement: NoteDisplacement) => void,
): Promise<Unlisten> {
  return getBridge().listen(NOTE_DISPLACED_EVENT, (payload) => {
    const parsed = noteDisplacedSchema.safeParse(payload)
    if (parsed.success) {
      handler(parsed.data)
    } else {
      // Contract drift must be loud: a dropped event leaves an open editor
      // saving the moved note over the other device's file.
      console.error('invalid note:displaced payload:', parsed.error)
    }
  })
}

/**
 * How long a displaced pair stays recorded: long enough for the watcher's
 * batches and the next reconcile pass to see the move and leave it alone.
 */
export const DISPLACED_RECORD_TTL_MS = 10 * 60_000

/** Recorded pairs, keyed `from\0to`, with when they expire. */
const recorded = new Map<string, number>()
let activeGeneration: number | null = null

function recordKey(from: string, to: string): string {
  return `${from}\u{0}${to}`
}

/** Adopt a file graph session, forgetting the previous session's displaced pairs. */
export function setDisplacedNotesGeneration(generation: number): void {
  if (activeGeneration !== generation) {
    recorded.clear()
    activeGeneration = generation
  }
}

/** Remember this graph session's pairs, ignoring results from older controllers. */
export function recordDisplacedNotes(
  pairs: ReadonlyArray<{ readonly from: string; readonly to: string }>,
  generation: number,
  now: number = Date.now(),
): void {
  if (generation !== activeGeneration) {
    return
  }
  for (const [key, expires] of recorded) {
    if (expires <= now) {
      recorded.delete(key)
    }
  }
  for (const pair of pairs) {
    recorded.set(recordKey(pair.from, pair.to), now + DISPLACED_RECORD_TTL_MS)
  }
}

/** Whether a pull recently moved the entry at `from` aside to `to`. */
export function isRecentlyDisplaced(from: string, to: string, now: number = Date.now()): boolean {
  const expires = recorded.get(recordKey(from, to))
  return expires !== undefined && expires > now
}

/** Forget every recorded pair (tests). */
export function clearDisplacedNotes(): void {
  recorded.clear()
}
