/**
 * Typed product routes (Plan 06). These are app states, not page names — the
 * integration point for navigation, back/forward history, and later deep links
 * and CLI `open` (Plan 14).
 *
 * Note identity is the graph-relative path in the first wave (Plan 03), so the
 * note route carries `path` — the reserved frontmatter `id` can join it later
 * without breaking the shape.
 */
import { returnNull } from '@ocavue/utils'
import { isIsoDate } from '@reflect/utils'
import {
  DEEP_LINK_SCHEME,
  dailyDeepLink,
  dailyPath,
  dateFromDailyPath,
  isDaily,
  NOTE_ATTACHMENT_TYPES,
  noteDeepLink,
  wikiFiltersEqual,
  type KnowledgeClassification,
  type NoteAttachmentType,
  type WikiFilter,
} from '@reflect/core'
import { z } from 'zod'

/**
 * What the All Notes list is narrowed to: one tag, attachment type, edit day, or level.
 */
export type AllNotesFilter =
  | { kind: 'tag'; tag: string }
  | { kind: 'attachment'; type: NoteAttachmentType }
  /** Notes last edited on this local day (ISO `YYYY-MM-DD`). */
  | { kind: 'updated'; date: string }
  | { kind: 'level'; level: KnowledgeClassification['level'] }

const attachmentTypeSchema = z.enum(NOTE_ATTACHMENT_TYPES)

const allNotesFilterSchema: z.ZodType<AllNotesFilter> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('tag'), tag: z.string() }),
  z.object({ kind: z.literal('attachment'), type: attachmentTypeSchema }),
  z.object({ kind: z.literal('updated'), date: z.string() }),
  z.object({
    kind: z.literal('level'),
    level: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  }),
])

const wikiFilterSchema: z.ZodType<WikiFilter> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('knowledge') }),
  z.object({ kind: z.literal('index') }),
  z.object({ kind: z.literal('flagged') }),
  z.object({ kind: z.literal('unreviewed') }),
  z.object({ kind: z.literal('unsourced') }),
  z.object({ kind: z.literal('untranslated'), folder: z.string() }),
  z.object({ kind: z.literal('tag'), tag: z.string() }),
])

/**
 * Parses a route that was stored as JSON.
 */
export const routeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('today') }),
  z.object({ kind: z.literal('daily'), date: z.string() }),
  z.object({ kind: z.literal('note'), path: z.string() }),
  z.object({ kind: z.literal('allNotes'), filter: allNotesFilterSchema.nullable() }),
  // Every media attachment in the graph, optionally narrowed to one type
  // and/or to files linked from notes carrying a tag.
  z.object({
    kind: z.literal('attachments'),
    type: attachmentTypeSchema.nullable(),
    tag: z.string().nullable(),
  }),
  // The graph's wiki entries. `filter` narrows the list; `language` is the
  // folder of the language entries open in (a `WikiLanguage.folder`), or null
  // for the source. Both live on the route so back/forward and "open an
  // entry, come back" keep them.
  z.object({
    kind: z.literal('wiki'),
    filter: wikiFilterSchema.nullable(),
    language: z.string().nullable(),
  }),
  z.object({ kind: z.literal('tasks') }),
  // `conversationId` names the conversation the entry shows; `null` (the
  // Chat button, ⌘J) stands for the conversation the chat session has open.
  z.object({ kind: z.literal('chat'), conversationId: z.string().nullable().default(null) }),
  // `graphs` (the graph switcher) and `licenses` (Open Source Licenses) are
  // mobile sub-screens of Settings. Desktop renders every page as the
  // settings screen: its graph switcher lives in the sidebar footer and its
  // licenses in a dialog.
  z.object({ kind: z.literal('settings'), page: z.enum(['main', 'graphs', 'licenses']) }),
])

export type Route = z.infer<typeof routeSchema>

/**
 * Parses a section that was stored as JSON.
 */
export const sectionSchema = z.enum(['daily', 'all', 'tasks', 'chat'])

/**
 * A top-level area of the app. Every history entry belongs to one section.
 */
export type Section = z.infer<typeof sectionSchema>

type RouteOf<K extends Route['kind']> = Extract<Route, { kind: K }>

/**
 * What the navigation layers need to know about one route kind.
 */
export interface RouteMeta<R extends Route> {
  /**
   * The section whose root screen the route shows, or `null` for a screen
   * that opens over the current section (a note, the settings screens).
   */
  readonly section: Section | null
  /**
   * The scroll surface that every entry of this kind shares, whose position
   * a section return restores, or `null` for per-entry scroll only. Today
   * and dated daily routes share one stream; the All list (any tag) and the
   * Tasks list have one each.
   */
  readonly scrollSurface: string | null
  /**
   * The screen under the route when no history is below it, where its Back
   * lands too.
   */
  readonly parent: (route: R) => Route
  /**
   * The deep link that addresses the route, or `null` for an in-app surface
   * that the deep-link grammar does not name.
   */
  readonly deepLink: (route: R) => string | null
}

const today = (): Route => ({ kind: 'today' })

/**
 * The metadata of every route kind, in one place.
 */
export const ROUTE_META: { readonly [K in Route['kind']]: RouteMeta<RouteOf<K>> } = {
  today: {
    section: 'daily',
    scrollSurface: 'daily',
    parent: today,
    deepLink: () => `${DEEP_LINK_SCHEME}://today`,
  },
  daily: {
    section: 'daily',
    scrollSurface: 'daily',
    parent: today,
    deepLink: (route) => dailyDeepLink(route.date),
  },
  note: {
    section: null,
    scrollSurface: null,
    parent: today,
    deepLink: (route) => noteDeepLink(route.path),
  },
  allNotes: { section: 'all', scrollSurface: 'allNotes', parent: today, deepLink: returnNull },
  attachments: { section: null, scrollSurface: null, parent: today, deepLink: returnNull },
  wiki: { section: null, scrollSurface: null, parent: today, deepLink: returnNull },
  tasks: {
    section: 'tasks',
    scrollSurface: 'tasks',
    parent: today,
    deepLink: () => `${DEEP_LINK_SCHEME}://tasks`,
  },
  chat: { section: 'chat', scrollSurface: null, parent: today, deepLink: returnNull },
  settings: {
    section: null,
    scrollSurface: null,
    parent: (route) => {
      return route.page === 'main' ? { kind: 'today' } : { kind: 'settings', page: 'main' }
    },
    deepLink: returnNull,
  },
}

/**
 * The metadata of `route`'s kind, typed for `route`.
 */
export function routeMeta<R extends Route>(route: R): RouteMeta<R> {
  return ROUTE_META[route.kind] as unknown as RouteMeta<R>
}

/**
 * The section whose root screen `route` shows, or `null` for a route that
 * opens over the current section (a note, the settings screens).
 */
export function rootSectionForRoute(route: Route): Section | null {
  return ROUTE_META[route.kind].section
}

/**
 * A route that addresses one concrete note, including a dated daily note.
 */
export type NoteRoute = Extract<Route, { kind: 'daily' | 'note' }>

/**
 * Structural route equality (used to avoid pushing no-op history entries).
 * Every route is a flat object of primitives.
 */
export function routesEqual(a: Route, b: Route): boolean {
  if (a.kind !== b.kind) {
    return false
  }
  // The filters are objects: two routes that name the same filter are equal.
  if (a.kind === 'allNotes') {
    return allNotesFiltersEqual(a.filter, (b as Extract<Route, { kind: 'allNotes' }>).filter)
  }
  if (a.kind === 'wiki') {
    const other = b as Extract<Route, { kind: 'wiki' }>
    return a.language === other.language && wikiFiltersEqual(a.filter, other.filter)
  }
  const aFields = Object.entries(a)
  return (
    aFields.length === Object.keys(b).length &&
    aFields.every(([key, value]) => (b as Record<string, unknown>)[key] === value)
  )
}

/**
 * The All Notes route narrowed to `tag`, or listing every note for `null`.
 */
export function allNotesRoute(tag: string | null): Extract<Route, { kind: 'allNotes' }> {
  return { kind: 'allNotes', filter: tag === null ? null : { kind: 'tag', tag } }
}

/**
 * The Wiki route: every entry, opening in the source language, unless told otherwise.
 */
export function wikiRoute(
  options: { filter?: WikiFilter | null; language?: string | null } = {},
): Extract<Route, { kind: 'wiki' }> {
  return { kind: 'wiki', filter: options.filter ?? null, language: options.language ?? null }
}

/**
 * The tag an All Notes filter narrows to, or null for no filter or a type filter.
 */
export function allNotesFilterTag(filter: AllNotesFilter | null): string | null {
  return filter?.kind === 'tag' ? filter.tag : null
}

/**
 * Structural equality of two All Notes filters.
 */
function allNotesFiltersEqual(a: AllNotesFilter | null, b: AllNotesFilter | null): boolean {
  if (a === null || b === null) {
    return a === b
  }
  switch (a.kind) {
    case 'tag':
      return b.kind === 'tag' && a.tag === b.tag
    case 'attachment':
      return b.kind === 'attachment' && a.type === b.type
    case 'updated':
      return b.kind === 'updated' && a.date === b.date
    case 'level':
      return b.kind === 'level' && a.level === b.level
  }
}

/**
 * The route a resolved note path navigates to: a real-calendar daily date opens
 * the daily view; anything else — including a `daily/…` file whose name is a
 * well-formed but impossible date (e.g. `2026-02-31`), which `dailyPath` would
 * reject — opens as a plain note so navigation can never crash the workspace.
 */
export function routeForPath(path: string): NoteRoute {
  const date = isDaily(path) ? dateFromDailyPath(path) : null
  return date !== null && isIsoDate(date) ? { kind: 'daily', date } : { kind: 'note', path }
}

/**
 * The daily date a route is anchored on: today's date for the `today` route
 * (hence the `today` parameter), the route's own date for `daily/:date`, and
 * null for any route that isn't a daily view (notes, search, chat, settings).
 */
function dailyDateForRoute(route: Route, today: string): string | null {
  switch (route.kind) {
    case 'today':
      return today
    case 'daily':
      return route.date
    default:
      return null
  }
}

/**
 * The daily date the user is *effectively* working on: the day focused in the
 * daily stream when there is one, otherwise the route's own daily date. Null
 * when the route isn't a daily view, where the focused day is irrelevant.
 *
 * The stream keeps a single `daily/:date` route as focus moves between days, so
 * the focused day — not the routed one — is what both the context sidebar and
 * note-scoped commands must point at. This is the one place that precedence
 * lives, so those two surfaces can never disagree about which day they target.
 */
export function effectiveDailyDate(
  route: Route,
  today: string,
  focusedDailyDate: string | null,
): string | null {
  const routed = dailyDateForRoute(route, today)
  return routed === null ? null : (focusedDailyDate ?? routed)
}

/**
 * The note file a route is editing — what note-scoped commands (pin, …) act
 * on: a note route's path, a daily route's file (today's for the `today`
 * route), and null for screens that edit no note (search, chat, settings).
 */
export function notePathForRoute(route: Route, today: string): string | null {
  if (route.kind === 'note') {
    return route.path
  }
  const daily = dailyDateForRoute(route, today)
  return daily === null ? null : dailyPath(daily)
}

/**
 * The note file the user is currently working in. Daily views resolve through
 * the focused stream day; all other routes use their directly addressed note.
 * This is the shared target for note-scoped commands and transient note chrome
 * such as Find, so neither can drift to a different virtualized day.
 */
export function focusedNotePathForRoute(
  route: Route,
  today: string,
  focusedDailyDate: string | null,
): string | null {
  const daily = effectiveDailyDate(route, today, focusedDailyDate)
  return daily !== null ? dailyPath(daily) : notePathForRoute(route, today)
}

/**
 * The invariant the router maintains on every entry: a `daily` route never
 * carries an impossible calendar date past the boundary (`dailyPath` would
 * throw on one downstream). A malformed date collapses to the `today` route —
 * the same anchoring the stream would choose — so views consuming
 * the router can trust `route.date` without re-validating it.
 */
export function normalizeRoute(route: Route): Route {
  return route.kind === 'daily' && !isIsoDate(route.date) ? { kind: 'today' } : route
}
