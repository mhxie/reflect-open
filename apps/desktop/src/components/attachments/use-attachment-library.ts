import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  buildAttachmentLibrary,
  listAttachmentNoteTags,
  listAttachmentReferences,
  listAttachments,
  type AttachmentLibraryEntry,
} from '@reflect/core'
import { useBridgeReady } from '@/hooks/use-bridge-ready.ts'
import { queryKeys } from '@/lib/query-client.ts'
import { useGraph } from '@/providers/graph-provider.tsx'

/**
 * The open graph's Attachments library, or undefined while it loads. The file
 * listing refetches when the attachment catalog is invalidated (the watcher
 * reports an attachment appearing or disappearing), the "linked from" notes
 * and their tags when the index changes, so the two halves stay live
 * independently.
 */
export function useAttachmentLibrary(): readonly AttachmentLibraryEntry[] | undefined {
  const { graph } = useGraph()
  const bridgeReady = useBridgeReady()
  const enabled = bridgeReady && graph !== null
  const generation = graph?.generation ?? 0

  const { data: files } = useQuery({
    queryKey: queryKeys.attachments.files(generation),
    queryFn: () => listAttachments(generation),
    enabled,
  })
  // One index query: the links and their notes' tags change together.
  const { data: index } = useQuery({
    queryKey: queryKeys.index.attachmentReferences(graph?.root),
    queryFn: async () => {
      const [references, noteTags] = await Promise.all([
        listAttachmentReferences(),
        listAttachmentNoteTags(),
      ])
      return { references, noteTags }
    },
    enabled,
  })

  return useMemo(
    () =>
      files === undefined || index === undefined
        ? undefined
        : buildAttachmentLibrary(files, index.references, index.noteTags),
    [files, index],
  )
}
