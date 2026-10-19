import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { buildAttachmentLibrary, type AttachmentLibraryEntry } from '@reflect/core'
import {
  createAttachmentFilesQueryOptions,
  createAttachmentReferencesQueryOptions,
} from '@/lib/query-options.ts'
import { useGraph } from '@/providers/graph-provider.tsx'
import { useCoreServices } from '@/services/services-provider.tsx'

/**
 * The open graph's Attachments library, or undefined while it loads. The file
 * listing refetches when the attachment catalog is invalidated (the watcher
 * reports an attachment appearing or disappearing), the "linked from" notes
 * and their tags when the index changes, so the two halves stay live
 * independently.
 */
export function useAttachmentLibrary(): readonly AttachmentLibraryEntry[] | undefined {
  const { graph } = useGraph()
  const { attachments, noteList } = useCoreServices()
  const enabled = graph !== null
  const generation = graph?.generation ?? 0

  const { data: files } = useQuery({
    ...createAttachmentFilesQueryOptions(attachments, generation),
    enabled,
  })
  // One index query: the links and their notes' tags change together.
  const { data: index } = useQuery({
    ...createAttachmentReferencesQueryOptions(noteList, graph?.root),
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
