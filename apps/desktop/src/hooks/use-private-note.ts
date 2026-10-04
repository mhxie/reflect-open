import { useState } from 'react'
import { isLocalOnlyPath } from '@reflect/core'
import { useNoteRowState } from '@/hooks/use-note-row.ts'

export interface PrivateNoteOptions {
  /**
   * The editor session showing the note (`useNoteDocument().sessionEpoch`),
   * or `null` for a surface without one. Within a session, the last index
   * row it resolved stays authoritative while a title-driven rename's new
   * path has no row yet (Plan 17), so a rename never flips the policy.
   * Without a session nothing carries over: a verdict for one note must
   * never stand in for another's.
   */
  readonly sessionEpoch: number | null
  /**
   * The live frontmatter verdict (`NoteSessionSnapshot.privateHeader`), or
   * `false` where no session holds the note's header.
   */
  readonly privateHeader: boolean
}

export interface PrivateNoteState {
  /** The verdict every editor surface follows; see {@link usePrivateNote}. */
  readonly privateNote: boolean
  /**
   * The note counts as private only because its index row is still loading:
   * the path and the live header both allow the network.
   */
  readonly pending: boolean
}

/**
 * {@link usePrivateNote}, plus whether the verdict is still waiting on the
 * index row, for a surface that would rather wait a moment than start out
 * under the fail-closed policy.
 */
export function usePrivateNoteState(
  path: string,
  { sessionEpoch, privateHeader }: PrivateNoteOptions,
): PrivateNoteState {
  const { row, settled } = useNoteRowState(path)
  // The last row this session resolved, adjusted during render (the
  // note-pane seed pattern).
  const [resolved, setResolved] = useState<{ epoch: number; isPrivate: boolean } | null>(null)
  if (
    sessionEpoch !== null &&
    row !== null &&
    (resolved?.epoch !== sessionEpoch || resolved.isPrivate !== row.isPrivate)
  ) {
    setResolved({ epoch: sessionEpoch, isPrivate: row.isPrivate })
  }
  const carried = sessionEpoch !== null && resolved?.epoch === sessionEpoch ? resolved : null
  const rowPrivate = row?.isPrivate ?? carried?.isPrivate
  const allowedElsewhere = !isLocalOnlyPath(path) && !privateHeader
  return {
    privateNote: !allowedElsewhere || (rowPrivate ?? true),
    pending: allowedElsewhere && rowPrivate === undefined && !settled,
  }
}

/**
 * Whether the note at `path` is private to every editor surface: its content
 * must not reach the network (embed lookups, remote images, link previews)
 * or a cloud AI provider. One predicate, failing closed:
 *
 * - the note sits in a local-only folder, or
 * - its live frontmatter is locked or unreadable, or
 * - its index row is private, or
 * - no row has resolved yet (a note still loading, or not indexed yet).
 *
 * The row is overlay-backed, so an in-app Lock toggle flips this at once; an
 * external edit flips it through the live header as soon as the open session
 * adopts it, before the watcher's re-index lands.
 */
export function usePrivateNote(path: string, options: PrivateNoteOptions): boolean {
  return usePrivateNoteState(path, options).privateNote
}
