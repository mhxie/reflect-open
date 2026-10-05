import { useQuery } from '@tanstack/react-query'
import { gitNoteVersion } from '@reflect/core'
import { useBridgeReady } from '@/hooks/use-bridge-ready.ts'
import { queryKeys } from '@/lib/query-client.ts'

interface NoteGitVersionOptions {
  readonly root: string | null
  readonly generation: number | null
  readonly path: string | null
  readonly open: boolean
  readonly isLocalOnly: boolean
}

/** A note's last committed Git version and the state of its lookup. */
export interface NoteGitVersion {
  readonly version: string | null
  readonly pending: boolean
  readonly unavailable: boolean
}

/**
 * The last committed version of this note, never an upload acknowledgment.
 * Refresh each time the detail view opens or the window regains focus;
 * Local-only notes stay out of Git queries. Each request remains in its
 * graph's file generation.
 */
export function useNoteGitVersion({
  root,
  generation,
  path,
  open,
  isLocalOnly,
}: NoteGitVersionOptions): NoteGitVersion {
  const bridgeReady = useBridgeReady()
  const enabled =
    open && !isLocalOnly && bridgeReady && root !== null && generation !== null && path !== null
  const query = useQuery({
    queryKey: queryKeys.git.noteVersion(root ?? undefined, generation, path),
    queryFn: async () =>
      generation === null || path === null ? null : await gitNoteVersion(path, generation),
    enabled,
    staleTime: 0,
    gcTime: 60_000,
    retry: false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
  })
  return {
    version: query.data ?? null,
    pending: query.isFetching,
    unavailable: query.isError,
  }
}
