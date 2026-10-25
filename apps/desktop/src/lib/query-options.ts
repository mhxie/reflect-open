import { queryOptions } from '@tanstack/react-query'
import {
  foldTag,
  type CoreServices,
  type DailyNoteService,
  type IndexQueryService,
  type NoteListOptions,
  type PreviewableAttachmentType,
  type WikiLanguage,
} from '@reflect/core'
import { queryKeys } from '@/lib/query-client.ts'
import type { AllNotesFilter } from '@/routing/route.ts'

/** Templates shared by the settings list and insertion picker. */
export function createTemplatesQueryOptions(
  indexQuery: IndexQueryService,
  root: string | undefined,
) {
  return queryOptions({
    queryKey: queryKeys.index.templates(root),
    queryFn: () => indexQuery.listTemplates(),
  })
}

/** Daily-note dates shared by desktop and mobile calendars. */
export function createDailyDatesQueryOptions(
  dailyNotes: DailyNoteService,
  root: string | undefined,
  start: string,
  end: string,
) {
  return queryOptions({
    queryKey: queryKeys.index.dailyDates(root, start, end),
    queryFn: () => dailyNotes.dailyDatesInRange(start, end),
  })
}

/**
 * The `listNotes` options for an All Notes route filter. A knowledge-level
 * filter narrows the full list (daily notes included) on the client.
 */
function noteListOptions(filter: AllNotesFilter | null): NoteListOptions {
  switch (filter?.kind) {
    case undefined:
      return {}
    case 'tag':
      return { tag: filter.tag }
    case 'attachment':
      return { attachment: filter.type }
    case 'updated':
      return { updatedOn: filter.date }
    case 'level':
      return { includeDaily: true }
  }
}

/** The list query's cache key for an All Notes route filter. */
function allNotesQueryKey(root: string | undefined, filter: AllNotesFilter | null) {
  switch (filter?.kind) {
    case undefined:
      return queryKeys.index.allNotesWithTag(root, null)
    case 'tag':
      return queryKeys.index.allNotesWithTag(root, foldTag(filter.tag))
    case 'attachment':
      return queryKeys.index.allNotesWithAttachment(root, filter.type)
    case 'updated':
      return queryKeys.index.allNotesUpdatedOn(root, filter.date)
    case 'level':
      return queryKeys.index.allNotesIncludingDaily(root)
  }
}

/**
 * The All Notes rows for a route filter (`null` = every non-daily note).
 * Shared by the All Notes screen and the heatmap's edited-notes preview, so a
 * day hovered there opens instantly in the list.
 */
export function createAllNotesQueryOptions(
  noteList: CoreServices['noteList'],
  root: string | undefined,
  filter: AllNotesFilter | null,
) {
  return queryOptions({
    queryKey: allNotesQueryKey(root, filter),
    queryFn: () => noteList.listNotes(noteListOptions(filter)),
  })
}

/** Note paths per previewable attachment type, for the All Notes galleries. */
export function createAttachmentPreviewsQueryOptions(
  noteList: CoreServices['noteList'],
  root: string | undefined,
  type: PreviewableAttachmentType,
) {
  return queryOptions({
    queryKey: queryKeys.index.attachmentPreviews(root, type),
    queryFn: () => noteList.listAttachmentPreviews(type),
  })
}

/**
 * The index half of the Attachments library: every attachment link and the
 * tags of the linking notes, in one query because they change together.
 */
export function createAttachmentReferencesQueryOptions(
  noteList: CoreServices['noteList'],
  root: string | undefined,
) {
  return queryOptions({
    queryKey: queryKeys.index.attachmentReferences(root),
    queryFn: async () => {
      const [references, noteTags] = await Promise.all([
        noteList.listAttachmentReferences(),
        noteList.listAttachmentNoteTags(),
      ])
      return { references, noteTags }
    },
  })
}

/**
 * The file half of the Attachments library: every attachment file of graph
 * session `generation` with its size and modification time. Re-listed when
 * the watcher reports an attachment change (`invalidateAttachmentFiles`).
 */
export function createAttachmentFilesQueryOptions(
  attachments: CoreServices['attachments'],
  generation: number,
) {
  return queryOptions({
    queryKey: queryKeys.attachments.files(generation),
    queryFn: () => attachments.listFiles(generation),
  })
}

/**
 * A PDF's page sizes for its inline preview, keyed by the catalog size so a
 * rewritten file reads again; `resetPdfInfo` covers a same-size rewrite. A
 * failure is not retried: the preview shows why instead.
 */
export function createPdfInfoQueryOptions(
  attachments: CoreServices['attachments'],
  generation: number,
  path: string,
  size: number | undefined,
) {
  return queryOptions({
    queryKey: queryKeys.pdf.info(generation, path, size),
    queryFn: () => attachments.pdfInfo(path, generation),
    staleTime: Infinity,
    retry: false,
  })
}

/**
 * The graph's wiki entries as of `asOf` (an ISO day), for the Wiki browser.
 * Keyed on the language folders, so a Settings → Wiki edit refetches.
 */
export function createWikiEntriesQueryOptions(
  wiki: CoreServices['wiki'],
  root: string | undefined,
  asOf: string,
  languages: readonly WikiLanguage[],
) {
  return queryOptions({
    queryKey: queryKeys.index.wikiEntries(root, asOf, languages),
    queryFn: () => wiki.listEntries({ asOf, languages }),
  })
}

/** Persisted chat conversations shared by desktop and mobile history menus. */
export function createChatConversationsQueryOptions(
  chatHistory: CoreServices['chatHistory'],
  root: string | undefined,
) {
  return queryOptions({
    queryKey: queryKeys.chat.conversations(root),
    queryFn: () => chatHistory.listRecent(),
  })
}
