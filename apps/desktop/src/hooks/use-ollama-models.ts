import { useQuery } from '@tanstack/react-query'
import type { OllamaModels } from '@reflect/core'
import { queryKeys } from '@/lib/query-client.ts'
import { useCoreServices } from '@/services/services-provider.tsx'

/** What the summary model picker knows about the Ollama server on this Mac. */
export interface OllamaModelsLookup {
  /** The last answer; `undefined` until the first look returns. */
  models: OllamaModels | undefined
  /** A look is in flight. */
  checking: boolean
  /** Look again (after the user started Ollama or pulled a model). */
  refresh: () => void
}

/**
 * The models installed in the Ollama server on this Mac, looked up while
 * `enabled`. Not retried: a server that isn't running answers at once, and
 * the picker offers to check again.
 */
export function useOllamaModels(enabled: boolean): OllamaModelsLookup {
  const { onDeviceModels } = useCoreServices()
  const query = useQuery({
    queryKey: queryKeys.ollamaModels,
    queryFn: ({ signal }) => onDeviceModels.listOllamaModels({ signal }),
    enabled,
    retry: false,
  })
  return {
    models: query.data,
    checking: query.isFetching,
    refresh: () => {
      void query.refetch()
    },
  }
}
