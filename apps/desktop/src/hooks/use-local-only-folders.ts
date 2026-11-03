import { NO_LOCAL_ONLY_FOLDERS, type GraphSessionState, type LocalOnlyFolders } from '@reflect/core'
import { useCoreServices } from '@/services/services-provider.tsx'
import { useSelector } from '@/lib/use-store.ts'

function selectLocalOnlyFolders(state: GraphSessionState): LocalOnlyFolders {
  return state.session?.localOnly ?? NO_LOCAL_ONLY_FOLDERS
}

/**
 * The open graph's local-only folders, for the predicates of
 * `@reflect/core`'s `local-only.ts`; none while no graph is open.
 */
export function useLocalOnlyFolders(): LocalOnlyFolders {
  const { graphSession } = useCoreServices()
  return useSelector(graphSession, selectLocalOnlyFolders)
}
