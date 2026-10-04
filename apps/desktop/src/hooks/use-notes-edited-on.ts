import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { listNotes, type NoteListEntry } from '@reflect/core'
import { useBridgeReady } from '@/hooks/use-bridge-ready.ts'
import { queryKeys } from '@/lib/query-client.ts'
import { useGraph } from '@/providers/graph-provider.tsx'

/** A hovered day loads only after the pointer rests this long, so a sweep fetches nothing. */
const DWELL_MS = 150

/**
 * The notes edited on `date` (`null` for none), newest first, once the date has
 * held for a moment. Shares All Notes' edit-day query, so opening that day's
 * list afterwards is instant.
 */
export function useNotesEditedOn(date: string | null): readonly NoteListEntry[] | undefined {
  const { graph } = useGraph()
  const bridgeReady = useBridgeReady()
  const [settled, setSettled] = useState<string | null>(null)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(date), DWELL_MS)
    return () => clearTimeout(timer)
  }, [date])
  const { data } = useQuery({
    queryKey: queryKeys.index.allNotesUpdatedOn(graph?.root, date ?? ''),
    queryFn: () => listNotes({ updatedOn: date }),
    enabled: date !== null && settled === date && bridgeReady && graph !== null,
    select: (notes) => notes.toSorted((left, right) => right.mtime - left.mtime),
  })
  return data
}
