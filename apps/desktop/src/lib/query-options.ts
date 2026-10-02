import { mutationOptions, queryOptions } from '@tanstack/react-query'
import {
  createAttachmentCatalog,
  dailyDatesInRange,
  listAttachments,
  getConflictedNotes,
  getDuplicateNoteIds,
  listChatConversations,
  listTemplates,
  loadSettings,
  pdfInfo,
  saveSettings,
} from '@reflect/core'
import { mutationKeys, mutationScopeIds, queryKeys } from '@/lib/query-client.ts'

/** Conflicted-note rows shared by every sync status and settings surface. */
export function createConflictedNotesQueryOptions(root: string | undefined) {
  return queryOptions({
    queryKey: queryKeys.index.conflictedNotes(root),
    queryFn: getConflictedNotes,
  })
}

/** Duplicate note IDs shared by the Git and iCloud settings surfaces. */
export function createDuplicateNoteIdsQueryOptions(root: string | undefined) {
  return queryOptions({
    queryKey: queryKeys.index.duplicateNoteIds(root),
    queryFn: getDuplicateNoteIds,
  })
}

/** Templates shared by the settings list and insertion picker. */
export function createTemplatesQueryOptions(root: string | undefined) {
  return queryOptions({
    queryKey: queryKeys.index.templates(root),
    queryFn: listTemplates,
  })
}

/** Daily-note dates shared by desktop and mobile calendars. */
export function createDailyDatesQueryOptions(root: string | undefined, start: string, end: string) {
  return queryOptions({
    queryKey: queryKeys.index.dailyDates(root, start, end),
    queryFn: () => dailyDatesInRange(start, end),
  })
}

/**
 * The vault's attachment listing for one graph session, reduced to what
 * display resolution reads so structural sharing keeps the result identical
 * (and every open editor unrefreshed) when only modification times change.
 * Freshness is event-driven: `useAttachmentCatalogSync` invalidates it.
 */
export function createAttachmentCatalogQueryOptions(generation: number) {
  return queryOptions({
    queryKey: queryKeys.attachments.catalog(generation),
    queryFn: async () => createAttachmentCatalog(await listAttachments(generation)),
    staleTime: Infinity,
  })
}

/**
 * A PDF's page sizes for its inline preview, keyed by the catalog size so a
 * rewritten file reads again; `resetPdfInfo` covers a same-size rewrite. A
 * failure is not retried: the preview shows why instead.
 */
export function createPdfInfoQueryOptions(
  generation: number,
  path: string,
  size: number | undefined,
) {
  return queryOptions({
    queryKey: queryKeys.pdf.info(generation, path, size),
    queryFn: () => pdfInfo(path, generation),
    staleTime: Infinity,
    retry: false,
  })
}

/** Persisted chat conversations shared by desktop and mobile history menus. */
export function createChatConversationsQueryOptions(root: string | undefined) {
  return queryOptions({
    queryKey: queryKeys.chat.conversations(root),
    queryFn: () => listChatConversations(),
  })
}

export function createSettingsQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.settings.all,
    queryFn: loadSettings,
    staleTime: Infinity,
  })
}
export function createSettingsSaveMutationOptions() {
  return mutationOptions({
    mutationKey: mutationKeys.settings.save,
    mutationFn: saveSettings,
    scope: { id: mutationScopeIds.settingsSave },
    retry: 0,
  })
}
