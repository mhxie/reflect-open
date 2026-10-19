import { useEffect } from 'react'
import { errorMessage } from '@reflect/core'
import { useGraph } from '@/providers/graph-provider.tsx'
import { useCoreServices } from '@/services/services-provider.tsx'

/**
 * Dev builds only: polls the dev harness for a search eval job once the graph
 * is ready, and runs each one through `SearchEvalService` (which scores the
 * search the app actually serves; see there for how a run is started).
 */

const POLL_MS = 2000

export function SearchEvalRunner(): null {
  const { status, indexGeneration } = useGraph()
  const { searchEval, logger } = useCoreServices()

  useEffect(() => {
    if (status !== 'ready' || indexGeneration === null) {
      return
    }
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async (): Promise<void> => {
      try {
        const job = await searchEval.poll()
        if (job !== null && !stopped) {
          await searchEval.run(job)
        }
      } catch (cause) {
        logger.error('search eval failed:', errorMessage(cause))
      }
      if (!stopped) {
        timer = setTimeout(() => void tick(), POLL_MS)
      }
    }
    timer = setTimeout(() => void tick(), POLL_MS)
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [status, indexGeneration, searchEval, logger])

  return null
}
