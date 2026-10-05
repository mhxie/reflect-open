import { isScalar } from 'yaml'
import type {
  FrontmatterBlockLoad,
  FrontmatterLoadFailure,
  ResolvedNode,
  RootPair,
} from './frontmatter-load.ts'

/**
 * The fail-closed frontmatter privacy classifier — one spec shared with the
 * Rust classifier (`crates/frontmatter/src/classify.rs`) and pinned on both
 * sides by `fixtures/frontmatter-privacy.json`. Any `private` value the app
 * could read as true classifies as `private` or `unreadable`, and
 * `unreadable` counts as private at every gate (the index bit, CloudSafe, the
 * AI menu, the CLI, commit subjects), so they all agree.
 *
 * Neither side uses its YAML library's own resolution for the `private`
 * value: both classify the scalar's text, style, and tag with the YAML 1.2
 * core schema below, so a value reads the same whichever parser produced it.
 */

/** Why a note's frontmatter can't be read with certainty; it is treated as locked. */
export type UnreadableFrontmatterReason =
  | FrontmatterLoadFailure
  /** `private` is set to something that is neither true nor false. */
  | 'unrecognizedValue'
  /**
   * A key spelled like `private` but not exactly (`Private`, `PRIVATE`,
   * `"private "`) is set to something other than false: the app reads only
   * `private`, so it can't tell whether the note was meant to be locked.
   */
  | 'privateKeyVariant'
  /**
   * A byte-order mark precedes the fence: the app sees no frontmatter, while
   * the block behind it locks the note.
   */
  | 'bomBeforeFence'

/** How a note's frontmatter classifies. Only `public` may leave the device. */
export type FrontmatterPrivacy =
  | { readonly kind: 'public' }
  | { readonly kind: 'private' }
  | { readonly kind: 'unreadable'; readonly reason: UnreadableFrontmatterReason }

/** How a `private` value reads. */
type ValueClass = 'private' | 'public' | 'unrecognized'

/** A scalar's value under the YAML 1.2 core schema. */
type CoreValue =
  | { readonly kind: 'null' }
  | { readonly kind: 'bool'; readonly value: boolean }
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'str'; readonly value: string }

const PUBLIC: FrontmatterPrivacy = { kind: 'public' }
const PRIVATE: FrontmatterPrivacy = { kind: 'private' }
const CORE_TAG_PREFIX = 'tag:yaml.org,2002:'
const PRIVATE_KEYS = ['private', '"private"', "'private'"] as const

/**
 * Classify one block (the text between the fences) from its load outcome:
 *
 * - **Line scan:** a column-0 `private:` line with a truthy value is
 *   `private`, whether or not the block loads.
 * - **Loaded block:** the root `private` value (tags unwrapped, aliases
 *   resolved): true/1/1.0/yes/on is `private`; false/0/null/no/off/empty or no
 *   key is `public`; anything else is `unreadable` (`unrecognizedValue`). A
 *   root key that is `private` only once ASCII-trimmed and case-folded
 *   (`Private`, `PRIVATE`) is `unreadable` (`privateKeyVariant`) unless its
 *   value is falsy.
 * - **Block not loaded:** `unreadable` when it contains `private` in any ASCII
 *   case or a backslash (a YAML escape can spell the key), else `public`.
 *
 * The byte-order-mark rule needs the whole source; see `frontmatterPrivacy`.
 */
export function classifyFrontmatterBlock(
  raw: string,
  load: FrontmatterBlockLoad,
): FrontmatterPrivacy {
  if (lineScanPrivate(raw)) {
    return PRIVATE
  }
  if (!load.loaded) {
    return asciiLowercase(raw).includes('private') || raw.includes('\\')
      ? { kind: 'unreadable', reason: load.reason }
      : PUBLIC
  }
  return rootPrivacy(load.rootPairs)
}

/**
 * The root mapping's `private` value. Alias keys can repeat the key without
 * a duplicate-key error, so every `private` key counts, most restrictive
 * first. A key that only folds to `private` never locks the note, but any
 * value other than a falsy one makes it unreadable.
 */
function rootPrivacy(pairs: readonly RootPair[]): FrontmatterPrivacy {
  let privacy = PUBLIC
  for (const { key, value } of pairs) {
    if (!isScalar(key) || key.source === undefined) {
      continue
    }
    const exact = key.source === 'private'
    if (!exact && asciiFold(key.source) !== 'private') {
      continue
    }
    const valueClass = classifyValue(value)
    if (exact && valueClass === 'private') {
      return PRIVATE
    }
    if (valueClass !== 'public') {
      privacy = { kind: 'unreadable', reason: exact ? 'unrecognizedValue' : 'privateKeyVariant' }
    }
  }
  return privacy
}

function classifyValue(value: ResolvedNode): ValueClass {
  // An empty value (`private:`), which the Rust parser reports as `~`.
  if (value === null) {
    return 'public'
  }
  if (!isScalar(value) || value.source === undefined) {
    return 'unrecognized'
  }
  return classifyScalar(value.source, value.type === 'PLAIN', value.tag)
}

/**
 * Classify a scalar `private` value. Non-core tags (`!x`, the non-specific
 * `!`) are unwrapped and the text resolved as if untagged; a core tag
 * resolves the text its own way regardless of quoting, and text the tag
 * rejects (`!!bool yes`) is private only when it is a truthy word.
 */
function classifyScalar(text: string, plain: boolean, tag: string | undefined): ValueClass {
  if (tag?.startsWith(CORE_TAG_PREFIX)) {
    const value = resolveCoreTagged(tag.slice(CORE_TAG_PREFIX.length), text)
    if (value !== undefined) {
      return classOf(value)
    }
    return wordClass(text) === 'private' ? 'private' : 'unrecognized'
  }
  return classifyUntagged(text, plain)
}

/** Plain text resolves under the core schema; quoted or block text is a string. */
function classifyUntagged(text: string, plain: boolean): ValueClass {
  return plain ? classOf(resolvePlain(text)) : wordClass(text)
}

function classOf(value: CoreValue): ValueClass {
  switch (value.kind) {
    case 'null':
      return 'public'
    case 'bool':
      return value.value ? 'private' : 'public'
    case 'number':
      return value.value === 1 ? 'private' : value.value === 0 ? 'public' : 'unrecognized'
    case 'str':
      return wordClass(value.value)
  }
}

/**
 * The truthy words, their falsy mirrors, and the empty string. Trimming and
 * case folding are ASCII-only on both sides: Unicode trimming differs
 * between JS and Rust, and anything outside the word lists is unrecognized
 * rather than public.
 */
function wordClass(text: string): ValueClass {
  const word = asciiFold(text)
  if (word === 'true' || word === 'yes' || word === 'on' || word === '1') {
    return 'private'
  }
  if (word === 'false' || word === 'no' || word === 'off' || word === '0' || word === '') {
    return 'public'
  }
  return 'unrecognized'
}

/** `text` without leading or trailing ASCII whitespace, ASCII-lowercased. */
function asciiFold(text: string): string {
  return asciiLowercase(text.replaceAll(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, ''))
}

/** `text` with only its ASCII letters lowercased, as Rust's `to_ascii_lowercase`. */
function asciiLowercase(text: string): string {
  return text.replaceAll(/[A-Z]+/g, (letters) => letters.toLowerCase())
}

function resolvePlain(text: string): CoreValue {
  return (
    resolveNull(text) ??
    resolveBool(text) ??
    resolveInt(text) ??
    resolveFloat(text) ?? { kind: 'str', value: text }
  )
}

function resolveCoreTagged(suffix: string, text: string): CoreValue | undefined {
  switch (suffix) {
    case 'str':
      return { kind: 'str', value: text }
    case 'null':
      return resolveNull(text)
    case 'bool':
      return resolveBool(text)
    case 'int':
      return resolveInt(text)
    case 'float':
      return resolveFloat(text)
    default:
      return undefined
  }
}

function resolveNull(text: string): CoreValue | undefined {
  return /^(?:~|null|Null|NULL)?$/.test(text) ? { kind: 'null' } : undefined
}

function resolveBool(text: string): CoreValue | undefined {
  if (text === 'true' || text === 'True' || text === 'TRUE') {
    return { kind: 'bool', value: true }
  }
  if (text === 'false' || text === 'False' || text === 'FALSE') {
    return { kind: 'bool', value: false }
  }
  return undefined
}

function resolveInt(text: string): CoreValue | undefined {
  if (/^0o[0-7]+$/.test(text)) {
    return { kind: 'number', value: parseInt(text.slice(2), 8) }
  }
  if (/^0x[0-9a-fA-F]+$/.test(text)) {
    return { kind: 'number', value: parseInt(text.slice(2), 16) }
  }
  return /^[-+]?\d+$/.test(text) ? { kind: 'number', value: Number(text) } : undefined
}

function resolveFloat(text: string): CoreValue | undefined {
  if (/^[-+]?\.(?:inf|Inf|INF)$/.test(text)) {
    return { kind: 'number', value: text.startsWith('-') ? -Infinity : Infinity }
  }
  if (/^\.(?:nan|NaN|NAN)$/.test(text)) {
    return { kind: 'number', value: NaN }
  }
  return /^[-+]?(?:\.\d+|\d+(?:\.\d*)?)(?:e[-+]?\d+)?$/i.test(text)
    ? { kind: 'number', value: Number(text) }
    : undefined
}

/**
 * Whether some column-0 `private:` line carries a truthy value. The key may
 * be quoted, and `!tag`/`&anchor` properties are skipped on both sides of
 * the colon; a quoted value is read verbatim (no escapes), an unquoted one up
 * to its comment and resolved like a plain scalar. Mirrors
 * `line_scan_private` in the Rust classifier character for character.
 */
export function lineScanPrivate(raw: string): boolean {
  return raw.split(/[\r\n]/).some((line) => lineValue(line) === 'private')
}

function lineValue(line: string): ValueClass | null {
  const keyed = skipProperties(line)
  const key = PRIVATE_KEYS.find((candidate) => keyed.startsWith(candidate))
  if (key === undefined) {
    return null
  }
  const afterKey = trimLeadingBlanks(keyed.slice(key.length))
  if (!afterKey.startsWith(':')) {
    return null
  }
  const value = skipProperties(trimLeadingBlanks(afterKey.slice(1)))
  const quote = value[0]
  if (quote === '"' || quote === "'") {
    return classifyUntagged(quotedText(value.slice(1), quote), false)
  }
  return classifyUntagged(stripComment(value), true)
}

function trimLeadingBlanks(text: string): string {
  return text.replace(/^[ \t]+/, '')
}

/**
 * Skip leading `!tag` and `&anchor` properties, each ended by a space or tab.
 * A property with nothing after it leaves nothing.
 */
function skipProperties(text: string): string {
  let rest = text
  while (rest.startsWith('!') || rest.startsWith('&')) {
    const end = rest.search(/[ \t]/)
    if (end === -1) {
      return ''
    }
    rest = trimLeadingBlanks(rest.slice(end))
  }
  return rest
}

/**
 * The text inside a quoted scalar that opened just before `rest`: up to the
 * closing quote (an escaped `\"` or a doubled `''` doesn't close), or the
 * rest of the line when it never closes.
 */
function quotedText(rest: string, quote: '"' | "'"): string {
  let index = 0
  while (index < rest.length) {
    const character = rest[index]
    if (quote === '"' && character === '\\') {
      index += 2
    } else if (character === quote && quote === "'" && rest[index + 1] === "'") {
      index += 2
    } else if (character === quote) {
      return rest.slice(0, index)
    } else {
      index += 1
    }
  }
  return rest
}

/**
 * An unquoted value without its trailing comment: a `#` that opens the value
 * or follows a space or tab starts one.
 */
function stripComment(value: string): string {
  let end = value.length
  for (let index = 0; index < value.length; index += 1) {
    const before = value[index - 1]
    if (value[index] === '#' && (index === 0 || before === ' ' || before === '\t')) {
      end = index
      break
    }
  }
  return value.slice(0, end).replace(/[ \t]+$/, '')
}
