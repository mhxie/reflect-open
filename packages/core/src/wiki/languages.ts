import { z } from 'zod'

/**
 * The wiki's languages (the `wikiLanguages` setting). Each language names the
 * graph folder holding its copy of every entry. The first language is the
 * source: its folder holds the entries themselves, grouped by their first
 * subfolder (the topic). The others hold translations at the same relative
 * paths (`wiki-cn/memory/Spacing Effect.md` translates
 * `wiki/memory/Spacing Effect.md`), the layout the atelier wiki schema uses.
 */

/** One wiki language: its display label and the graph folder of its copy. */
export interface WikiLanguage {
  readonly label: string
  /** Graph-relative folder, without leading or trailing slashes. */
  readonly folder: string
}

/** Where a note sits in the wiki: its language and its path inside that language's folder. */
export interface WikiLocation {
  readonly language: WikiLanguage
  readonly relativePath: string
}

const DEFAULT_SOURCE: WikiLanguage = { label: 'English', folder: 'wiki' }

/** One entry of the stored `wikiLanguages` setting, before its folder is checked. */
const storedLanguageSchema = z.object({ label: z.string(), folder: z.string() })

/** The languages a fresh install starts with: English entries, Simplified Chinese translations. */
export const DEFAULT_WIKI_LANGUAGES: readonly WikiLanguage[] = [
  DEFAULT_SOURCE,
  { label: '简体中文', folder: 'wiki-cn' },
]

/**
 * A typed folder as a graph-relative path, or null when it cannot name one:
 * trimmed, outer slashes dropped, and every segment a plain name (not empty,
 * not `.`/`..`, not hidden, no backslash or control character).
 */
export function normalizeWikiFolder(input: string): string | null {
  const segments = input
    .trim()
    .replaceAll(/^\/+|\/+$/g, '')
    .split('/')
  const valid = segments.every(
    (segment) =>
      segment.trim() === segment &&
      segment !== '' &&
      !segment.startsWith('.') &&
      !segment.includes('\\') &&
      [...segment].every((char) => char.charCodeAt(0) >= 0x20),
  )
  return valid ? segments.join('/') : null
}

/** Whether one folder is the other or lies inside it. */
function overlaps(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}

/**
 * The stored setting as a usable list: entries need a label and a valid
 * folder, a folder that overlaps an earlier one (the same, or nested either
 * way) is dropped so no note belongs to two languages, and an empty result
 * falls back to {@link DEFAULT_WIKI_LANGUAGES}.
 */
export function normalizeWikiLanguages(entries: readonly unknown[]): WikiLanguage[] {
  const languages: WikiLanguage[] = []
  for (const entry of entries) {
    const parsed = storedLanguageSchema.safeParse(entry)
    const label = parsed.success ? parsed.data.label.trim() : ''
    const folder = parsed.success ? normalizeWikiFolder(parsed.data.folder) : null
    if (label === '' || folder === null) {
      continue
    }
    if (languages.some((language) => overlaps(language.folder, folder))) {
      continue
    }
    languages.push({ label, folder })
  }
  return languages.length > 0 ? languages : [...DEFAULT_WIKI_LANGUAGES]
}

/** The source language: the first in the list (a normalized list is never empty). */
export function wikiSourceLanguage(languages: readonly WikiLanguage[]): WikiLanguage {
  return languages[0] ?? DEFAULT_SOURCE
}

/** The part of `path` below `folder/`, or null when `path` is not inside `folder`. */
function pathBelow(folder: string, path: string): string | null {
  const prefix = `${folder}/`
  return path.startsWith(prefix) && path.length > prefix.length ? path.slice(prefix.length) : null
}

/** The language folder `path` lies in and its path there, or null outside the wiki. */
export function wikiLocation(
  path: string,
  languages: readonly WikiLanguage[],
): WikiLocation | null {
  for (const language of languages) {
    const relativePath = pathBelow(language.folder, path)
    if (relativePath !== null) {
      return { language, relativePath }
    }
  }
  return null
}

/** Whether `path` is a wiki entry in any of the wiki's languages. */
export function isWikiPath(path: string, languages: readonly WikiLanguage[]): boolean {
  return wikiLocation(path, languages) !== null
}

/** The path of the entry at `relativePath` in `language`'s copy. */
export function wikiPathIn(language: WikiLanguage, relativePath: string): string {
  return `${language.folder}/${relativePath}`
}

/** The topic folder of a wiki-relative path, or null for an entry at the wiki root. */
export function wikiTopic(relativePath: string): string | null {
  const slash = relativePath.indexOf('/')
  return slash === -1 ? null : relativePath.slice(0, slash)
}
