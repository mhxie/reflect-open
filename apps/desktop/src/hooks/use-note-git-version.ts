import { useQuery } from '@tanstack/react-query'
import { gitNoteVersion } from '@reflect/core'
import { useBridgeReady } from '@/hooks/use-bridge-ready.ts'

interface NoteGitVersionOptions {
  readonly root: string | null
  readonly generation: number | null
  readonly path: string | null
  readonly open: boolean
  readonly isLocalOnly: boolean
}

interface NoteGitVersion {
  readonly version: string | null
  readonly pending: boolean
  readonly unavailable: boolean
}

/**
 * The last committed version of this note, never an upload acknowledgment.
 * Refresh on each detail view and poll while open; Local-only notes stay out
 * of Git queries. Each request remains in its graph's file generation.
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
    queryKey: ['note-git-version', root, generation, path],
    queryFn: async () =>
      generation === null || path === null ? null : await gitNoteVersion(path, generation),
    enabled,
    staleTime: 0,
    gcTime: 60_000,
    retry: false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
    refetchInterval: enabled ? 15_000 : false,
  })
  return {
    version: query.data ?? null,
    pending: query.isFetching,
    unavailable: query.isError,
  }
}
