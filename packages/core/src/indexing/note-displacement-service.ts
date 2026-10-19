import { z } from 'zod'
import type { GraphSessionSource } from '../graph/graph-session.ts'
import { listenNow, type IpcBridgeService } from '../ipc/ipc-service.ts'
import type { ClockService } from '../ports/clock-service.ts'
import type { LoggerService } from '../ports/logger-service.ts'
import type { Unlisten } from '../unlisten.ts'

/**
 * Event name a Git pull emits for each entry it left moved aside.
 */
export const NOTE_DISPLACED_EVENT = 'note:displaced'

const noteDisplacedSchema = z.object({
  generation: z.number().int().nonnegative(),
  from: z.string(),
  to: z.string(),
  /**
   * The moved note is locked (or its frontmatter can't be read).
   */
  keptOut: z.boolean(),
})

/**
 * One entry a pull moved aside: graph-relative `from` → `to`, in the file
 * session `generation`.
 */
export type NoteDisplacement = z.infer<typeof noteDisplacedSchema>

/**
 * How long a displaced pair stays recorded: long enough for the watcher's
 * batches and the next reconcile pass to see the move and leave it alone.
 */
export const DISPLACED_RECORD_TTL_MS = 10 * 60_000

export interface NoteDisplacementServiceDeps {
  readonly ipc: IpcBridgeService
  readonly clock: ClockService
  readonly logger: LoggerService
  readonly graphSession: GraphSessionSource
}

/**
 * The entries Git pulls move aside, and the move-healing suppression for them.
 *
 * A pull that finds this device's note where the other device wrote one moves
 * the local note aside (`a.md` → `a (this device).md`). To the indexer that
 * looks exactly like an external rename, and healing it would retarget an
 * open editor onto the wrong note, so the pull's pairs are recorded here and
 * move healing leaves them alone. The records belong to one file session:
 * they reset whenever the open graph's `generation` changes, and a record for
 * any other generation is ignored, so a pull of the previous graph can never
 * suppress healing in the next one.
 */
export interface NoteDisplacementService {
  /**
   * Listen for entries pulls move aside. A malformed payload is reported as an
   * error and dropped: contract drift must be loud, because a dropped event
   * leaves an open editor saving the moved note over the other device's file.
   */
  onDisplaced(listener: (displacement: NoteDisplacement) => void): Unlisten
  /**
   * Remember `pairs` a pull of the file session `generation` moved aside, for
   * {@link DISPLACED_RECORD_TTL_MS}. Ignored unless `generation` is the open
   * graph's: a late result from an older session never lands in this one.
   */
  record(
    pairs: ReadonlyArray<{ readonly from: string; readonly to: string }>,
    generation: number,
  ): void
  /**
   * Whether a pull of the open graph session recently moved the entry at
   * `from` aside to `to`.
   */
  isRecentlyDisplaced(from: string, to: string): boolean
}

function recordKey(from: string, to: string): string {
  return `${from}\u{0}${to}`
}

class NoteDisplacementServiceImpl implements NoteDisplacementService {
  readonly #deps: NoteDisplacementServiceDeps
  /**
   * Recorded pairs, keyed `from\0to`, with when they expire.
   */
  readonly #recorded = new Map<string, number>()
  /**
   * The file generation the records belong to; `null` with no graph open.
   */
  #generation: number | null = null

  constructor(deps: NoteDisplacementServiceDeps) {
    this.#deps = deps
  }

  onDisplaced(listener: (displacement: NoteDisplacement) => void): Unlisten {
    const { ipc, logger } = this.#deps
    return listenNow(
      () =>
        ipc.listen(NOTE_DISPLACED_EVENT, (payload) => {
          const parsed = noteDisplacedSchema.safeParse(payload)
          if (parsed.success) {
            listener(parsed.data)
          } else {
            logger.error(`invalid ${NOTE_DISPLACED_EVENT} payload:`, parsed.error)
          }
        }),
      (cause) => {
        logger.warn(`failed to listen for "${NOTE_DISPLACED_EVENT}"`, cause)
      },
    )
  }

  record(
    pairs: ReadonlyArray<{ readonly from: string; readonly to: string }>,
    generation: number,
  ): void {
    if (!this.#followSession() || generation !== this.#generation) {
      return
    }
    const now = this.#deps.clock.now()
    for (const [key, expires] of this.#recorded) {
      if (expires <= now) {
        this.#recorded.delete(key)
      }
    }
    for (const pair of pairs) {
      this.#recorded.set(recordKey(pair.from, pair.to), now + DISPLACED_RECORD_TTL_MS)
    }
  }

  isRecentlyDisplaced(from: string, to: string): boolean {
    if (!this.#followSession()) {
      return false
    }
    const expires = this.#recorded.get(recordKey(from, to))
    return expires !== undefined && expires > this.#deps.clock.now()
  }

  /**
   * Adopt the open graph's file generation, forgetting the previous session's
   * pairs when it changed. False when no graph is open.
   */
  #followSession(): boolean {
    const generation = this.#deps.graphSession.getState().session?.generation ?? null
    if (generation !== this.#generation) {
      this.#recorded.clear()
      this.#generation = generation
    }
    return generation !== null
  }
}

export function createNoteDisplacementService(
  deps: NoteDisplacementServiceDeps,
): NoteDisplacementService {
  return new NoteDisplacementServiceImpl(deps)
}
