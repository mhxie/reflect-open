import { NO_LOCAL_ONLY_FOLDERS, type LocalOnlyFolders } from '@reflect/core'
import { useCoreServices } from '@/services/services-provider.tsx'
import { useServiceState } from '@/services/use-service-state.ts'

/**
 * The open graph's local-only folders, for the predicates of
 * `@reflect/core`'s `local-only.ts`; none while no graph is open.
 */
export function useLocalOnlyFolders(): LocalOnlyFolders {
  const { graphSession } = useCoreServices()
  return useServiceState(
    graphSession,
    () => graphSession.getState().session?.localOnly ?? NO_LOCAL_ONLY_FOLDERS,
  )
}
