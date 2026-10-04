import { useEffect, useRef } from 'react'
import { recordDisplacedNotes, subscribeNoteDisplaced } from '@reflect/core'
import { followDisplacedNote } from '@/editor/move-note.ts'
import { useBridgeReady } from '@/hooks/use-bridge-ready.ts'
import { trackSubscriptions } from '@/lib/subscriptions.ts'
import { useGraph } from '@/providers/graph-provider.tsx'

/** Follow pull displacements only while their issuing file graph session is active. */
export function NoteDisplacements(): null {
  const bridgeReady = useBridgeReady()
  const { graph, status } = useGraph()
  const generation = status === 'ready' ? graph?.generation : undefined
  const currentGeneration = useRef(generation)
  currentGeneration.current = generation

  useEffect(() => {
    if (!bridgeReady || generation === undefined) {
      return
    }
    let active = true
    const isCurrent = (): boolean => active && currentGeneration.current === generation
    const subscriptions = trackSubscriptions()
    void subscriptions.add(
      subscribeNoteDisplaced((displacement) => {
        if (!isCurrent() || displacement.generation !== generation) {
          return
        }
        const { from, to, keptOut } = displacement
        recordDisplacedNotes([displacement], generation)
        void followDisplacedNote(from, to, keptOut, generation, isCurrent)
      }),
    )
    return () => {
      active = false
      subscriptions.disposeAll()
    }
  }, [bridgeReady, generation])

  return null
}
