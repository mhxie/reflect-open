/**
 * `@reflect/core` indexing layer (Plan 04) — the TS pipeline that turns parsed
 * notes into the SQLite projection, plus the typed read getters over it.
 */
export {
  openIndex,
  applyIndexedNote,
  applyIndexedNotes,
  removeFromIndex,
  moveNoteIndexed,
  clearIndex,
  setIndexMeta,
  watchStart,
  watchStop,
} from './commands.ts'
export {
  FILE_CHANGES_EVENT,
  RECONCILE_EVENT,
  subscribeFileChanges,
  subscribeReconcileRequests,
  emitFileChanges,
  type FileChange,
} from './file-changes.ts'
export { setLocalWriteEcho, subscribeOwnWrites } from './local-write-echo.ts'
export { subscribeIcloudConflicts, subscribeIcloudWatchFailed } from './icloud-conflicts.ts'
export { subscribeIndexApplied, type IndexAppliedListener } from './index-applied.ts'
export { cjkColumnText } from './cjk.ts'
export { INDEX_WRITTEN_EVENT, subscribeIndexWritten } from './index-written.ts'
export { NOTE_MOVED_EVENT, subscribeNoteMoved } from './note-moved.ts'
export {
  subscribeIndexChanges,
  applyIndexChanges,
  type ApplyErrorHandler,
  type MovedHandler,
} from './live.ts'
export { hashContent } from './hash.ts'
export { availableTemplatePath, slugPathForTitle, templateSlugPathForTitle } from './note-paths.ts'
export { listTemplates, type TemplateEntry } from './template-list.ts'
export {
  buildIndexedNote,
  CLAIM_TIER,
  decodeTaskBreadcrumbs,
  encodeTaskBreadcrumbs,
  indexedNoteSchema,
  indexedLinkSchema,
  indexedTagSchema,
  indexedAliasSchema,
  PROJECTION_VERSION,
  type IndexedNote,
  type IndexedLink,
  type IndexedTag,
  type IndexedAlias,
} from './indexed-note.ts'
export {
  indexNote,
  reindexNotesReferencing,
  rebuildIndex,
  reconcileIndex,
  syncIndex,
  PROJECTION_VERSION_KEY,
  type IndexPassOptions,
} from './indexer.ts'
export {
  dailyDatesInRange,
  getBacklinks,
  getBacklinksWithContext,
  getConflictedNotes,
  getDuplicateNoteIds,
  getIndexMeta,
  getLinkSources,
  getPathLinkSources,
  getNote,
  getNoteMtime,
  getNotesByTag,
  getOpenTasks,
  getCompletedTasks,
  getPinnedNotes,
  getWikiAddressForPath,
  suggestWikiTargets,
  suggestWikiLinkTargets,
  suggestTags,
  getIndexedFileFacts,
  getIndexedFileFactsByPath,
  listDailyNotes,
  resolveWikiTarget,
  type Backlink,
  type BacklinkContext,
  type BacklinkContextPage,
  type BacklinkContextPageOptions,
  type BacklinkSourceCursor,
  type ConflictedNote,
  type DailyNoteRow,
  type DailyNotesRange,
  type DuplicateIdGroup,
  type NoteRow,
  type OpenTask,
  type PinnedNote,
  type TagSuggestion,
  type WikiLinkSuggestionResult,
} from './queries.ts'
export { resolveNoteTarget } from './resolve-target.ts'
export {
  listDailyActivity,
  listDailyEditCounts,
  type DailyActivity,
  type DailyEditCount,
} from './daily-activity.ts'
export {
  activityLevel,
  activityThresholds,
  heatmapWeeks,
  monthLabelColumns,
  type ActivityLevel,
  type ActivityThresholds,
} from './activity-scale.ts'
export { listOnThisDay, type OnThisDayEntry } from './on-this-day.ts'
export {
  groupTaskContexts,
  groupTasks,
  taskDateBucket,
  tasksForDay,
  type DayTasks,
  type TaskContext,
  type TaskGroup,
  type TaskGroupKind,
} from './group-tasks.ts'
export {
  sortNoteListRows,
  chooseNoteListSort,
  reverseNoteListSort,
  type NoteListSort,
  type NoteListSortKey,
} from './note-list-sort.ts'
export {
  listAttachmentPreviews,
  listNotes,
  listNoteTags,
  listRecentNotes,
  type NoteListEntry,
  type NoteListOptions,
  type NoteTagFacet,
  type PreviewableAttachmentType,
  type RecentNoteRow,
  type RecentNotesOptions,
} from './note-list.ts'
export {
  aliasHint,
  rankWikiSuggestions,
  mergeDateSuggestions,
  serializeWikiSuggestionAddress,
  type WikiLinkSuggestion,
  type WikiSuggestion,
  type GeneratedDate,
} from './suggest.ts'
export {
  generateDateSuggestions,
  type DateSuggestion,
  type DateSuggestionContext,
} from './date-suggestions.ts'
export {
  cleanSnippetText,
  parseHighlights,
  randomNotePath,
  HIGHLIGHT_START,
  HIGHLIGHT_END,
  type HighlightSegment,
} from './search.ts'
export { lineAt, lineSnippet, previewSnippet } from './snippet.ts'
export {
  blockContextAt,
  blockContextLinesAt,
  prepareBlockContext,
  type BlockContextLines,
  type BlockContextSource,
} from './block-context.ts'
export { extractSnippetTasks, type SnippetTask } from './snippet-tasks.ts'
export { parseSearchQuery, type ParsedSearchQuery, type SearchFilters } from './filter-query.ts'
export {
  searchNotes,
  searchWithFilters,
  type FilteredSearchHit,
  type FilteredSearchOptions,
  type SearchHit,
} from './filtered-search.ts'
export {
  rewriteLinksForTitleChange,
  rewritePathLinksForMove,
  nextAliases,
  type RenameBacklink,
  type RenameIo,
  type TitleRenameRewriteOptions,
  type TitleRenameRewriteResult,
} from './rename.ts'
