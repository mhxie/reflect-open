import { sql } from 'kysely'
import { displayNoteTitle, noteTitlePresentation } from '../markdown/note-title.ts'
import type { DatabaseService } from './database-service.ts'
import type { ParsedSearchQuery } from './filter-query.ts'
import { recallOrder } from './queries-shared.ts'
import { buildFtsMatch, buildTitleMatchSql, cjkSnippetSql } from './search-query.ts'
import { HIGHLIGHT_END, HIGHLIGHT_START } from './search.ts'
import { highlightTitle } from './title-highlight.ts'
import type { WikiResolverService } from './wiki-resolver-service.ts'

/**
 * The one palette search (Plan 08): parsed filter tokens become composable
 * predicates on `notes` (EXISTS subqueries against `tags` and the `backlinks`
 * view), with free text constraining and ranking through FTS plus folded
 * title recall. Title recall matches each query term at a title word start —
 * except terms in unsegmented scripts such as Japanese, which match anywhere:
 * FTS5's default `unicode61` tokenizer treats an uninterrupted title as one
 * token, so a shorter title query can never match it lexically
 * (`buildTitleMatchSql`). Free-text ranking promotes exact, prefix, then
 * all-terms title matches ahead of body hits, followed by title-boosted bm25,
 * pinned, and recency. Filters may be empty — plain text search is the
 * degenerate case, so there is exactly one search path to keep correct.
 * Without text, results order by recency — a (possibly filtered) recall feed.
 * The mobile All tab reuses that recall feed as its filtered list via
 * {@link FilteredSearchOptions}.
 */

export interface FilteredSearchHit {
  path: string
  title: string
  /**
   * The note's display title (`display_title`, or a localized note's H1), when it has one.
   */
  displayTitle?: string | null | undefined
  /**
   * The note's `lang` frontmatter, when it has one.
   */
  lang?: string | null | undefined
  /**
   * The title's display form (a `//` subject reduced to its first segment)
   * with search matches marked; plain when the title did not match.
   */
  highlightedTitle: string
  dailyDate: string | null
  /**
   * Highlighted body snippet when free text was searched, else null.
   */
  snippet: string | null
  /**
   * The indexed row preview — the no-text feed's row snippet.
   */
  preview: string
  /**
   * The note's fresh AI summary for the no-text feed, which shows it in place
   * of `preview`; always empty when free text was searched, so search results
   * never show AI-written text.
   */
  summary: string
  /**
   * File modification time (epoch ms) — drives the row's recency label.
   */
  mtime: number
  isPinned: boolean
  /**
   * Privacy flags from the same index snapshot as the snippet.
   */
  isPrivate: boolean
  hasDeviceOnlyContent: boolean
  /**
   * Identity of attachment text folded into this search snapshot.
   */
  assetTextHash?: string
}

export interface FilteredSearchOptions {
  /**
   * Result cap (default 12, the palette's row budget). `null` removes the cap
   * — only sensible for the no-text recall feed behind a virtualized list;
   * free-text callers should keep one.
   */
  limit?: number | null
  /**
   * Order the no-text recall feed pinned-first (explicit pin order, then
   * unordered pins), then by recency — the All list's V1 order. Free-text
   * results keep relevance ranking regardless.
   */
  pinnedFirst?: boolean
  /**
   * Restrict the population to regular notes (`kind = 'note'`), matching the
   * All list. An explicit `is:daily` filter wins over this — the two would
   * otherwise contradict to an always-empty result.
   */
  notesOnly?: boolean
}

/**
 * The columns every hit carries besides the FTS snippet.
 */
const HIT_COLUMNS = [
  'notes.path',
  'notes.title',
  'notes.displayTitle',
  'notes.lang',
  'notes.isPrivate',
  'notes.hasDeviceOnlyContent',
  'notes.assetTextHash',
  'notes.dailyDate',
  'notes.preview',
  'notes.summary',
  'notes.mtime',
  'notes.isPinned',
] as const

type HitFlags = Pick<FilteredSearchHit, 'isPinned' | 'isPrivate' | 'hasDeviceOnlyContent'>

/**
 * SQLite stores the hit's flags as 0/1 integers; every result path decodes them here.
 */
function hitFlags(row: Record<keyof HitFlags, number>): HitFlags {
  return {
    isPinned: row.isPinned !== 0,
    isPrivate: row.isPrivate !== 0,
    hasDeviceOnlyContent: row.hasDeviceOnlyContent !== 0,
  }
}

export interface SearchServiceDeps {
  readonly database: DatabaseService
  readonly wikiResolver: WikiResolverService
}

/**
 * The palette's full-text search with filters.
 */
export interface SearchService {
  /**
   * Search the graph with parsed filters (see {@link FilteredSearchOptions}).
   */
  searchWithFilters(
    parsed: ParsedSearchQuery,
    options?: FilteredSearchOptions,
  ): Promise<FilteredSearchHit[]>
}

class SearchServiceImpl implements SearchService {
  readonly #deps: SearchServiceDeps

  constructor(deps: SearchServiceDeps) {
    this.#deps = deps
  }

  async searchWithFilters(
    parsed: ParsedSearchQuery,
    options: FilteredSearchOptions = {},
  ): Promise<FilteredSearchHit[]> {
    const { wikiResolver } = this.#deps
    const { db } = this.#deps.database
    const { filters } = parsed
    const limit = options.limit === undefined ? 12 : options.limit

    // Link filters name a note by title/alias/date; resolve it once up front.
    // An unresolvable target matches nothing (the filter is explicit — silently
    // ignoring it would show results the user just excluded). Picker-set exact
    // paths skip resolution entirely — the caller already holds the note, and
    // resolving its title could land on a duplicate.
    let linksToPath: string | null = filters.linksToPath ?? null
    if (linksToPath === null && filters.linksTo !== null) {
      const resolution = await wikiResolver.resolveWikiTarget(filters.linksTo)
      if (resolution.kind !== 'resolved') {
        return []
      }
      linksToPath = resolution.ref
    }
    let linkedFromPath: string | null = filters.linkedFromPath ?? null
    if (linkedFromPath === null && filters.linkedFrom !== null) {
      const resolution = await wikiResolver.resolveWikiTarget(filters.linkedFrom)
      if (resolution.kind !== 'resolved') {
        return []
      }
      linkedFromPath = resolution.ref
    }

    const match = buildFtsMatch(parsed.text)
    // An explicit daily filter and the notes-only population contradict; the
    // filter is the user's latest word, so it wins.
    const notesOnly = options.notesOnly === true && !filters.dailyOnly

    if (match === null && filters.tags.length > 0) {
      const [primaryTag, ...remainingTags] = filters.tags
      let taggedQuery = db
        .selectFrom('tags')
        .innerJoin('notes', 'notes.path', 'tags.notePath')
        .select(HIT_COLUMNS)
        // The length guard above guarantees a primary tag.
        .where('tags.tagKey', '=', primaryTag!)
        .where('notes.kind', '!=', 'template')
        .distinct()

      for (const tag of remainingTags) {
        taggedQuery = taggedQuery.where((eb) => {
          return eb.exists(
            eb
              .selectFrom('tags as filterTags')
              .select(sql<number>`1`.as('one'))
              .whereRef('filterTags.notePath', '=', 'notes.path')
              .where('filterTags.tagKey', '=', tag),
          )
        })
      }
      if (filters.dailyOnly) {
        taggedQuery = taggedQuery.where('notes.dailyDate', 'is not', null)
      }
      if (notesOnly) {
        taggedQuery = taggedQuery.where('notes.kind', '=', 'note')
      }
      if (filters.pinnedOnly) {
        taggedQuery = taggedQuery.where('notes.isPinned', '=', 1)
      }
      if (linksToPath !== null) {
        const target = linksToPath
        taggedQuery = taggedQuery.where((eb) => {
          return eb.exists(
            eb
              .selectFrom('backlinks')
              .select(sql<number>`1`.as('one'))
              .whereRef('backlinks.sourcePath', '=', 'notes.path')
              .where('backlinks.targetPath', '=', target),
          )
        })
      }
      if (linkedFromPath !== null) {
        const source = linkedFromPath
        taggedQuery = taggedQuery.where((eb) => {
          return eb.exists(
            eb
              .selectFrom('backlinks')
              .select(sql<number>`1`.as('one'))
              .whereRef('backlinks.targetPath', '=', 'notes.path')
              .where('backlinks.sourcePath', '=', source),
          )
        })
      }
      if (filters.updatedAfterMs !== null) {
        taggedQuery = taggedQuery.where('notes.mtime', '>=', filters.updatedAfterMs)
      }
      if (filters.updatedBeforeMs !== null) {
        taggedQuery = taggedQuery.where('notes.mtime', '<', filters.updatedBeforeMs)
      }
      if (limit !== null) {
        taggedQuery = taggedQuery.limit(limit)
      }

      for (const order of recallOrder(options.pinnedFirst === true)) {
        taggedQuery = taggedQuery.orderBy(order)
      }
      const rows = await taggedQuery.execute()
      return rows.map((row) => ({
        ...row,
        highlightedTitle: noteTitlePresentation(row.title, row).text,
        snippet: null,
        ...hitFlags(row),
      }))
    }

    // Templates never surface in search — they are boilerplate, not notes.
    let query = db.selectFrom('notes').select(HIT_COLUMNS).where('notes.kind', '!=', 'template')

    // `filters.tags` are folded keys (filter-query) matched against the stored
    // `tag_key` — folded in JS at index time, since SQLite's lower() is
    // ASCII-only and would miss non-ASCII casings.
    for (const tag of filters.tags) {
      query = query.where((eb) => {
        return eb.exists(
          eb
            .selectFrom('tags')
            .select(sql<number>`1`.as('one'))
            .whereRef('tags.notePath', '=', 'notes.path')
            .where('tags.tagKey', '=', tag),
        )
      })
    }
    if (filters.dailyOnly) {
      query = query.where('notes.dailyDate', 'is not', null)
    }
    if (notesOnly) {
      query = query.where('notes.kind', '=', 'note')
    }
    if (filters.pinnedOnly) {
      query = query.where('notes.isPinned', '=', 1)
    }
    if (linksToPath !== null) {
      const target = linksToPath
      query = query.where((eb) => {
        return eb.exists(
          eb
            .selectFrom('backlinks')
            .select(sql<number>`1`.as('one'))
            .whereRef('backlinks.sourcePath', '=', 'notes.path')
            .where('backlinks.targetPath', '=', target),
        )
      })
    }
    if (linkedFromPath !== null) {
      const source = linkedFromPath
      query = query.where((eb) => {
        return eb.exists(
          eb
            .selectFrom('backlinks')
            .select(sql<number>`1`.as('one'))
            .whereRef('backlinks.targetPath', '=', 'notes.path')
            .where('backlinks.sourcePath', '=', source),
        )
      })
    }
    if (filters.updatedAfterMs !== null) {
      query = query.where('notes.mtime', '>=', filters.updatedAfterMs)
    }
    if (filters.updatedBeforeMs !== null) {
      query = query.where('notes.mtime', '<', filters.updatedBeforeMs)
    }
    if (match === null) {
      // No free text: a filtered recall feed, newest first.
      let recallQuery = query
      for (const order of recallOrder(options.pinnedFirst === true)) {
        recallQuery = recallQuery.orderBy(order)
      }
      if (limit !== null) {
        recallQuery = recallQuery.limit(limit)
      }
      const rows = await recallQuery.execute()
      return rows.map((row) => ({
        ...row,
        highlightedTitle: noteTitlePresentation(row.title, row).text,
        snippet: null,
        ...hitFlags(row),
      }))
    }

    // SQLite rejects `MATCH ... OR title_key LIKE ...`, and flattening an FTS
    // subquery under this notes-first join reruns MATCH for every note. An
    // explicitly materialized CTE computes lexical hits once, while the outer
    // join safely admits title-recall-only rows. The admission OR can't use an
    // index, so the ranked path scans the (filtered) notes table once per
    // query — `instr` over titles is cheap at graph scale.
    //
    // Ranking reads only bm25 scores; the display columns (`snippet()` above
    // all, which re-tokenizes a note's whole body) are built in a second MATCH
    // for just the ranked page. A short prefix matches most of a graph, and
    // snippeting every match first made those queries ~10× slower.
    const titleMatch = buildTitleMatchSql(sql.ref<string>('filteredNotes.titleKey'), parsed.text)
    const rankedDb = db
      .with(
        (cte) => cte('lexical').materialized(),
        (queryDb) => {
          return queryDb
            .selectFrom('searchFts')
            .select([
              'searchFts.path',
              sql<number>`bm25(search_fts, 0, 10.0, 1.0, 1.0)`.as('rank'),
              // Non-zero exactly when the body holds a match: the case where
              // `snippet()` over the body would carry a highlight.
              sql<number>`bm25(search_fts, 0, 0.0, 1.0, 0.0)`.as('bodyRank'),
            ])
            .where(sql<boolean>`search_fts MATCH ${match}`)
        },
      )
      .with(
        (cte) => cte('ranked').materialized(),
        (queryDb) => {
          let rankedQuery = queryDb
            .selectFrom(query.select('notes.titleKey').as('filteredNotes'))
            .leftJoin('lexical', 'lexical.path', 'filteredNotes.path')
            .select([
              'filteredNotes.path',
              'filteredNotes.title',
              'filteredNotes.displayTitle',
              'filteredNotes.lang',
              'filteredNotes.isPrivate',
              'filteredNotes.hasDeviceOnlyContent',
              'filteredNotes.assetTextHash',
              'filteredNotes.dailyDate',
              'filteredNotes.preview',
              'filteredNotes.mtime',
              'filteredNotes.isPinned',
              titleMatch.rank.as('titleRank'),
              // A title-only prefix already admitted by manual recall keeps its
              // historical rank (`0`). Tokenizer-only title matches such as
              // `cafe` -> `Café` retain lexical bm25 so they still outrank body
              // hits.
              sql<number>`case
                when ${sql.ref('lexical.bodyRank')} != 0 or not (${titleMatch.containsAllTerms})
                then coalesce(${sql.ref('lexical.rank')}, 0)
                else 0
              end`.as('lexicalRank'),
            ])
            .where(
              sql<boolean>`(${sql.ref('lexical.path')} is not null or ${titleMatch.containsAllTerms})`,
            )
            .orderBy('titleRank')
            .orderBy('lexicalRank')
            .orderBy('filteredNotes.isPinned', 'desc')
            .orderBy('filteredNotes.mtime', 'desc')
            .orderBy('filteredNotes.path', 'asc')
          if (limit !== null) {
            rankedQuery = rankedQuery.limit(limit)
          }
          return rankedQuery
        },
      )
      .with(
        (cte) => cte('display').materialized(),
        (queryDb) => {
          return queryDb
            .selectFrom('searchFts')
            .select([
              'searchFts.path',
              sql<string>`highlight(search_fts, 1, ${HIGHLIGHT_START}, ${HIGHLIGHT_END})`.as(
                'ftsHighlightedTitle',
              ),
              sql<string>`snippet(search_fts, 2, ${HIGHLIGHT_START}, ${HIGHLIGHT_END}, '…', 10)`.as(
                'snippet',
              ),
              cjkSnippetSql(parsed.text, HIGHLIGHT_START, HIGHLIGHT_END).as('cjkSnippet'),
            ])
            .where(sql<boolean>`search_fts MATCH ${match}`)
            .where('searchFts.path', 'in', queryDb.selectFrom('ranked').select('ranked.path'))
        },
      )
    const rankedQuery = rankedDb
      .selectFrom('ranked')
      .leftJoin('display', 'display.path', 'ranked.path')
      .select([
        'ranked.path',
        'ranked.title',
        'ranked.displayTitle',
        'ranked.lang',
        'ranked.isPrivate',
        'ranked.hasDeviceOnlyContent',
        'ranked.assetTextHash',
        'ranked.dailyDate',
        'ranked.preview',
        'ranked.mtime',
        'ranked.isPinned',
        'display.ftsHighlightedTitle',
        'display.snippet',
        'display.cjkSnippet',
      ])
      // The CTE's order doesn't survive the join: restate it. `path` is unique,
      // so the order is total and matches the ranked page exactly.
      .orderBy('ranked.titleRank')
      .orderBy('ranked.lexicalRank')
      .orderBy('ranked.isPinned', 'desc')
      .orderBy('ranked.mtime', 'desc')
      .orderBy('ranked.path', 'asc')
    const rows = await rankedQuery.execute()
    return rows.map(({ ftsHighlightedTitle, snippet, cjkSnippet, ...row }) => ({
      ...row,
      summary: '',
      // SQLite returns an unmarked body fragment when only the title or the
      // `cjk` column matched. That is not a search snippet; a CJK run found in
      // the body gets its own marked fragment instead.
      snippet: snippet?.includes(HIGHLIGHT_START) === true ? snippet : cjkSnippet,
      // The FTS markers describe the complete title; the same display
      // derivation keeps them aligned with the shortened title they highlight.
      highlightedTitle: highlightTitle(
        noteTitlePresentation(row.title, row).text,
        parsed.text,
        ftsHighlightedTitle === null || row.displayTitle != null
          ? null
          : displayNoteTitle(ftsHighlightedTitle),
      ),
      ...hitFlags(row),
    }))
  }
}

export function createSearchService(deps: SearchServiceDeps): SearchService {
  return new SearchServiceImpl(deps)
}
