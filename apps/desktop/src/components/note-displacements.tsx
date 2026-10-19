import { useEffect, useLayoutEffect, useRef } from 'react'
import { useGraph } from '@/providers/graph-provider.tsx'
import { useCoreServices } from '@/services/services-provider.tsx'

/** Follow pull displacements only while their issuing file graph session is active. */
export function NoteDisplacements(): null {
  const { noteDisplacement, noteMove } = useCoreServices()
  const { graph, status } = useGraph()
  const generation = status === 'ready' ? graph?.generation : undefined
  const currentGenerationRef = useRef(generation)
  // Committed before the subscription effect's cleanup runs, so a generation
  // that has changed is seen at once; never written during render.
  useLayoutEffect(() => {
    currentGenerationRef.current = generation
  }, [generation])

  useEffect(() => {
    if (generation === undefined) {
      return
    }
    let active = true
    const isCurrent = (): boolean => active && currentGenerationRef.current === generation
    const unlisten = noteDisplacement.onDisplaced((displacement) => {
      if (!isCurrent() || displacement.generation !== generation) {
        return
      }
      const { from, to, keptOut } = displacement
      noteDisplacement.record([displacement], generation)
      void noteMove.followDisplacedNote(from, to, keptOut, generation, isCurrent)
    })
    return () => {
      active = false
      unlisten()
    }
  }, [generation, noteDisplacement, noteMove])

  return null
}
