import type { NoteFileService } from '../graph/note-file-service.ts'
import { foldGraphPath } from '../graph/paths.ts'
import { parseNote } from '../markdown/index.ts'
import type { IndexQueryService } from './index-query-service.ts'
import { pairMovesById, type DetectedMove } from './move-detection.ts'
import type { NoteDisplacementService } from './note-displacement-service.ts'

/**
 * External-move detection (Plan 17), shared by the open-time reconcile
 * (`indexer.ts`) and the live watcher batch (`live.ts`). Both observe the
 * same shape after a rename Reflect didn't perform: an indexed row whose file
 * vanished (an **orphan**) and an unindexed file that appeared (an
 * **arrival**). When an arrival carries an orphan's frontmatter id, the pair
 * is a move — the caller migrates the rows instead of delete+create, so
 * embedding vectors survive (re-embedding identical content costs the user
 * BYOK money).
 *
 * Detection is best-effort by contract: callers treat a thrown error or a
 * missed pair as "no move detected" and fall back to plain delete+create,
 * which always converges. The healing flow end-to-end (including how the
 * desktop layer carries open sessions and routes along) is documented in
 * `docs/readable-filenames.md`.
 */

/**
 * What {@link MoveHealing.detectExternalMoves} found.
 */
export interface ExternalMoveScan {
  /**
   * Orphan→arrival pairs whose frontmatter ids matched unambiguously.
   */
  moves: DetectedMove[]
  /**
   * Arrival content read while pairing, keyed by path — handed back so the
   * caller's indexing pass doesn't read the same files twice.
   */
  content: Map<string, string>
}

export interface MoveHealingDeps {
  readonly noteFile: NoteFileService
  readonly indexQuery: IndexQueryService
  readonly noteDisplacement: NoteDisplacementService
}

/**
 * Pairs vanished index rows with arrived files by frontmatter id.
 */
export interface MoveHealing {
  /**
   * Pair orphaned index rows with arrived files by frontmatter id. An
   * unreadable arrival simply can't pair (the caller's plain path retries the
   * read); an ambiguous id never pairs (see {@link pairMovesById}). An abort
   * mid-scan returns no moves: the caller is about to bail anyway. Arrivals
   * are read at the file generation `fileGeneration`.
   *
   * Two shapes that look like a move are not one, and never pair:
   * - an orphan whose path holds a file again by the time of pairing (a pull
   *   moved this device's note aside and wrote the other device's there);
   * - a pair a pull recorded as moved aside
   *   ({@link NoteDisplacementService.isRecentlyDisplaced}), where the other
   *   device deleted the path.
   * Healing either would retarget an open editor onto the wrong note. A
   * rename that changed only the case or Unicode normalization of a path
   * still pairs: on a volume that folds names, the old spelling's existence
   * probe would find the arrival itself.
   */
  detectExternalMoves(
    orphanPaths: string[],
    arrivalPaths: string[],
    fileGeneration: number,
    options?: { signal?: AbortSignal | undefined },
  ): Promise<ExternalMoveScan>
}

class MoveHealingImpl implements MoveHealing {
  readonly #deps: MoveHealingDeps

  constructor(deps: MoveHealingDeps) {
    this.#deps = deps
  }

  async detectExternalMoves(
    orphanPaths: string[],
    arrivalPaths: string[],
    fileGeneration: number,
    options?: { signal?: AbortSignal | undefined },
  ): Promise<ExternalMoveScan> {
    const { noteFile, indexQuery, noteDisplacement } = this.#deps
    const content = new Map<string, string>()
    if (orphanPaths.length === 0 || arrivalPaths.length === 0) {
      return { moves: [], content }
    }
    const missing = await this.#withoutPresentPaths(orphanPaths, arrivalPaths)
    if (missing.length === 0 || options?.signal?.aborted) {
      return { moves: [], content }
    }
    const orphanIds = await indexQuery.getNoteIdsByPath(missing)
    const arrivalIds = new Map<string, string | null>()
    for (const path of arrivalPaths) {
      if (options?.signal?.aborted) {
        return { moves: [], content }
      }
      try {
        const source = await noteFile.read(path, fileGeneration)
        content.set(path, source)
        const parsed = parseNote({ path, source })
        arrivalIds.set(path, parsed.frontmatter.id ?? null)
      } catch {
        // Unreadable arrival: it can't pair; the caller's plain path retries.
      }
    }
    const moves = pairMovesById(orphanIds, arrivalIds).filter(
      (move) => !noteDisplacement.isRecentlyDisplaced(move.from, move.to),
    )
    return { moves, content }
  }

  /**
   * The orphans whose file is still gone. An orphan whose path folds
   * ({@link foldGraphPath}) onto a differently spelled arrival is not probed:
   * on a volume that folds case and normalization, the probe would answer for
   * that arrival, and the pair is a rename of the spelling alone. A probe
   * that fails counts as present: the orphan then takes the plain
   * delete+create path, which always converges.
   */
  async #withoutPresentPaths(paths: string[], arrivals: string[]): Promise<string[]> {
    const { noteFile } = this.#deps
    const spellings = new Map<string, string[]>()
    for (const arrival of arrivals) {
      const key = foldGraphPath(arrival)
      spellings.set(key, [...(spellings.get(key) ?? []), arrival])
    }
    const present = await Promise.all(
      paths.map(async (path) => {
        const respelled = spellings.get(foldGraphPath(path))?.some((arrival) => arrival !== path)
        if (respelled === true) {
          return false
        }
        return await noteFile.exists(path).catch(() => true)
      }),
    )
    return paths.filter((_path, position) => present[position] !== true)
  }
}

export function createMoveHealing(deps: MoveHealingDeps): MoveHealing {
  return new MoveHealingImpl(deps)
}
