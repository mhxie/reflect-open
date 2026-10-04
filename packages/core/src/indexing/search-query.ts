/**
 * FTS5 query construction (Plan 04).
 *
 * FTS5 interprets a raw `MATCH` argument as query syntax, so operators in user
 * input (`AND`, `OR`, `NOT`, `*`, `(`, `"`) would either change the meaning of
 * the search or raise a syntax error. {@link buildFtsMatch} defends that boundary:
 * it splits the query on whitespace and wraps every term in a double-quoted
 * string (doubling any embedded quote, FTS5's own escape), then adds an FTS5
 * prefix operator outside the escaped literal. Each term independently matches
 * a word prefix in either the title or body while remaining robust to whatever
 * the user types. A term in a script written without spaces also matches as a
 * substring, through the `cjk` column's character pairs (`cjk.ts`).
 */

import { sql, type RawBuilder } from 'kysely'
import { foldKey } from '../markdown/index.ts'
import { isUnsegmented, letterSegments, runBigrams, unsegmentedRuns } from './cjk.ts'

/** Split a free-text query into the terms shared by FTS and title recall. */
export function splitSearchTerms(query: string): string[] {
  return query.trim().split(/\s+/).filter(Boolean)
}

/**
 * A character `unicode61` keeps inside a token: its default `categories` is
 * `'L* N* Co'`, so letters, numbers and private-use codepoints of every script
 * count (Han, kana, Hangul and Thai included), while punctuation, symbols and
 * combining marks separate tokens. `is_fts_token_char` (`apps/cli/src/search.rs`)
 * mirrors this codepoint for codepoint; the two must move together.
 */
const FTS_TOKEN_CHAR_RE = /[\p{L}\p{N}\p{Co}]/u

/** Wrap a term as an FTS5 string literal, doubling quotes (FTS5's own escape). */
function quoteFtsLiteral(term: string): string {
  return `"${term.replaceAll('"', '""')}"`
}

/** Whether `unicode61` finds any token in a term, i.e. whether FTS can see it. */
function isTokenizable(term: string): boolean {
  return FTS_TOKEN_CHAR_RE.test(term)
}

/**
 * The terms a search constrains on: those `unicode61` can tokenize. A term of
 * pure punctuation tokenizes to an empty phrase, which as an operand of the
 * explicit `AND` matches no rows and would take the whole query with it, so it
 * constrains neither the FTS expression nor title recall. When no term
 * survives, the originals are kept: the query is punctuation only, and title
 * recall can still match it literally (`.` finds `.hidden files`).
 */
export function searchTerms(query: string): string[] {
  const terms = splitSearchTerms(query)
  const tokenizable = terms.filter(isTokenizable)
  return tokenizable.length > 0 ? tokenizable : terms
}

/**
 * Build a word-prefix FTS5 `MATCH` expression over titles and bodies, or `null`
 * when there is nothing to search. FTS5 errors on an empty `MATCH`, so callers
 * should treat `null` as an empty result set rather than passing it to the
 * database.
 *
 * A punctuation-only query has no tokenizable term to constrain on, so it gets
 * the quoted join: a valid, matchless expression that still lets title recall
 * admit rows, exactly as it behaved before prefixes.
 */
export function buildFtsMatch(query: string): string | null {
  const terms = searchTerms(query)
  if (terms.length === 0) {
    return null
  }
  if (!terms.some(isTokenizable)) {
    return terms.map(quoteFtsLiteral).join(' ')
  }
  return terms
    .map((term) => {
      const literal = quoteFtsLiteral(term)
      return `(title : ${literal}* OR body : ${literal}* OR ${cjkTermMatch(term, literal)})`
    })
    .join(' AND ')
}

/**
 * A term's match in the `cjk` column. A word written against a run indexes
 * only there; a term holding runs (`用Python写脚本`) matches each run as a
 * substring and each letter stretch in any column, since a note may spell it
 * glued or spaced.
 */
function cjkTermMatch(term: string, literal: string): string {
  const runs = unsegmentedRuns(term)
  if (runs.length === 0) {
    return `cjk : ${literal}*`
  }
  const parts = [
    ...runs.map(cjkRunMatch),
    ...letterSegments(term).map((segment) => {
      const quoted = quoteFtsLiteral(segment)
      return `(cjk : ${quoted}* OR title : ${quoted}* OR body : ${quoted}*)`
    }),
  ]
  return parts.length === 1 ? parts[0]! : `(${parts.join(' AND ')})`
}

/**
 * A run of an unsegmented script as a substring of the `cjk` column: the phrase
 * of its character pairs, or — for one character — any token it starts (a
 * pair, or a run's final character).
 */
function cjkRunMatch(run: string): string {
  return [...run].length === 1
    ? `cjk : ${quoteFtsLiteral(run)}*`
    : `cjk : ${quoteFtsLiteral(runBigrams(run).join(' '))}`
}

/** True when `value` contains a character from a script written without spaces. */
export function containsUnsegmentedScript(value: string): boolean {
  for (const char of value) {
    if (isUnsegmented(char)) {
      return true
    }
  }
  return false
}

/**
 * Words too common to tell notes apart. bm25 already discounts them, but
 * dropping them keeps a sentence-long query's expression short.
 */
const ANY_TERM_STOPWORDS = new Set(
  (
    'a about after all also an and any are as at be been but by can could did do does for from ' +
    'had has have he her his how i if in into is it its just like may me more most my no not of ' +
    'on one only or other our out over she so some such than that the their them then there ' +
    'these they this those to too up us very was we were what when where which while who why ' +
    'will with would you your'
  ).split(' '),
)

/** Bounds on an any-term expression, so one pasted page can't cost a full scan per word. */
const ANY_TERM_MAX_WORDS = 64
const ANY_TERM_MAX_PAIRS = 128

/** Words from which a query reads as a sentence rather than a few keywords. */
const SENTENCE_MIN_WORDS = 4

/**
 * Whether `query` reads as a sentence: four words or more, a run of CJK
 * characters counting one word per two characters. Few notes hold every word
 * of a sentence, so `retrieve` tops such a query up with any-term matches; a
 * few keywords stay strict, where a partial match is mostly noise.
 */
export function isSentenceLike(query: string): boolean {
  const latin = [...query].map((char) => (isUnsegmented(char) ? ' ' : char)).join('')
  const words = latin.split(/[^\p{L}\p{N}\p{Co}]+/u).filter((word) => word !== '').length
  const cjkWords = unsegmentedRuns(query).reduce(
    (count, run) => count + Math.ceil([...run].length / 2),
    0,
  )
  return words + cjkWords >= SENTENCE_MIN_WORDS
}

/**
 * An any-term FTS5 expression for long, natural-language queries (`retrieve`),
 * or `null` when nothing in the query is searchable. {@link buildFtsMatch}
 * requires every term, so a sentence matches nothing; here each word and each
 * CJK character pair counts on its own and bm25 ranks notes by how many of the
 * rarer ones they hold. Words of four letters or more match as prefixes, a
 * cheap stand-in for stemming (`meeting` finds `meetings`).
 */
export function buildFtsAnyMatch(query: string): string | null {
  const words = new Set<string>()
  const latin = [...query].map((char) => (isUnsegmented(char) ? ' ' : char)).join('')
  for (const word of latin.toLowerCase().split(/[^\p{L}\p{N}\p{Co}]+/u)) {
    if ([...word].length >= 2 && !ANY_TERM_STOPWORDS.has(word) && words.size < ANY_TERM_MAX_WORDS) {
      words.add(word)
    }
  }
  const pairs = new Set<string>()
  for (const pair of unsegmentedRuns(query).flatMap(runBigrams)) {
    if (pairs.size < ANY_TERM_MAX_PAIRS) {
      pairs.add(pair)
    }
  }
  const alternatives = [
    ...[...words].map((word) => `${quoteFtsLiteral(word)}${[...word].length >= 4 ? '*' : ''}`),
    ...[...pairs].map((pair) => `cjk : ${quoteFtsLiteral(pair)}`),
  ]
  return alternatives.length === 0 ? null : alternatives.join(' OR ')
}

export interface TitleRecallTerm {
  /** Query term folded exactly like the indexed title key. */
  readonly value: string
  /** Whether the term matches anywhere rather than only at a title word start. */
  readonly anywhere: boolean
}

/** Resolve query terms into the shared title-recall matching policy. */
export function titleRecallTerms(query: string): TitleRecallTerm[] {
  return searchTerms(query)
    .map(foldKey)
    .map((value) => ({
      value,
      anywhere: containsUnsegmentedScript(value),
    }))
}

/**
 * The `instr` needles for title recall, one per query term, folded like
 * `notes.title_key`. Matched with `instr(' ' || title_key, needle)`: terms in
 * space-delimited scripts carry a leading space so they only match at word
 * starts (`car` finds `Car log`, not `Oscar party`), while unsegmented-script
 * terms match anywhere ({@link containsUnsegmentedScript}) — `unicode61`
 * cannot segment those, so word starts don't exist to anchor on.
 */
export function titleRecallNeedles(query: string): string[] {
  return titleRecallTerms(query).map((term) => (term.anywhere ? term.value : ` ${term.value}`))
}

export interface TitleMatchSql {
  /**
   * True when every query term matches the folded title — at a word start for
   * space-delimited scripts, anywhere for unsegmented ones.
   */
  readonly containsAllTerms: RawBuilder<boolean>
  /** Exact (0), whole-query prefix (1), all-terms title match (2), else 3. */
  readonly rank: RawBuilder<number>
}

/**
 * Build title-recall SQL against a stored, already-folded title-key column.
 * Every query term must match per {@link titleRecallNeedles}, so `東京 旅行`
 * matches `東京旅行計画` even though `unicode61` sees the uninterrupted title
 * as one token, while `car` never matches `Oscar party`.
 */
export function buildTitleMatchSql(
  titleKeyColumn: RawBuilder<string>,
  query: string,
): TitleMatchSql {
  const needles = titleRecallNeedles(query)
  const containsAllTerms =
    needles.length === 0
      ? sql<boolean>`0`
      : sql<boolean>`(${sql.join(
          needles.map((needle) => sql`instr(' ' || ${titleKeyColumn}, ${needle}) > 0`),
          sql` and `,
        )})`
  const titleKey = foldKey(query)
  return {
    containsAllTerms,
    rank: sql<number>`case
      when ${titleKeyColumn} = ${titleKey} then 0
      when instr(${titleKeyColumn}, ${titleKey}) = 1 then 1
      when ${containsAllTerms} then 2
      else 3
    end`,
  }
}
