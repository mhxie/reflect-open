/**
 * The `search_fts.cjk` column (migration 0023).
 *
 * FTS5's `unicode61` tokenizer only splits at characters that aren't letters
 * or digits, so a run of Han, kana or Hangul indexes as one token and a word
 * inside a clause can never match. Worse, a Latin word written against a run
 * (`用Python写脚本`) joins that token, so even `python` misses it. The writer
 * stores what the other columns can't see ({@link cjkColumnText}): each run's
 * overlapping character pairs and final character, and each stretch of
 * letters or digits glued to a run. A query matches a run as the phrase of its
 * pairs ({@link runBigrams}), which is a substring match. Mirrors
 * `crates/index-schema/src/cjk.rs`; the parity corpus keeps the two in
 * lockstep.
 */

/**
 * Scripts written without spaces between words (Han, kana, Hangul, Thai, …).
 * Space-delimited scripts must stay out: `car` may find `Car log` but never
 * `Oscar party`.
 */
const UNSEGMENTED_SCRIPT_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0e00, 0x0eff], // Thai, Lao
  [0x1000, 0x109f], // Myanmar
  [0x1100, 0x11ff], // Hangul Jamo
  [0x1780, 0x17ff], // Khmer
  [0x3005, 0x3007], // Japanese iteration marks (々〆〇)
  [0x3040, 0x30ff], // Hiragana, Katakana
  [0x3130, 0x318f], // Hangul Compatibility Jamo
  [0x31f0, 0x31ff], // Katakana Phonetic Extensions
  [0x3400, 0x4dbf], // CJK Extension A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xac00, 0xd7af], // Hangul Syllables
  [0xf900, 0xfaff], // CJK Compatibility Ideographs
  [0xff66, 0xff9f], // Halfwidth Katakana
  [0x20000, 0x2fa1f], // CJK Extensions B–F, Compatibility Supplement
]

/** Rust's `char::is_alphanumeric`: the `Alphabetic` property or a numeric category. */
const ALPHANUMERIC_RE = /[\p{Alphabetic}\p{N}]/u

/** Whether `char` (one code point) belongs to a script written without spaces. */
export function isUnsegmented(char: string): boolean {
  const codePoint = char.codePointAt(0) ?? 0
  return UNSEGMENTED_SCRIPT_RANGES.some(([start, end]) => codePoint >= start && codePoint <= end)
}

/** Letters and digits outside the unsegmented scripts: what can sit against a run without a space. */
function isSegmentChar(char: string): boolean {
  return ALPHANUMERIC_RE.test(char) && !isUnsegmented(char)
}

/** The maximal stretches of `text` whose characters all pass `test`. */
function stretches(text: string, test: (char: string) => boolean): string[] {
  const found: string[] = []
  let stretch = ''
  for (const char of text) {
    if (test(char)) {
      stretch += char
    } else if (stretch !== '') {
      found.push(stretch)
      stretch = ''
    }
  }
  if (stretch !== '') {
    found.push(stretch)
  }
  return found
}

/** The maximal runs of unsegmented-script characters in `text`. */
export function unsegmentedRuns(text: string): string[] {
  return stretches(text, isUnsegmented)
}

/** The maximal stretches of letters and digits outside the unsegmented scripts (`Python` in `用Python写脚本`). */
export function letterSegments(text: string): string[] {
  return stretches(text, isSegmentChar)
}

/** A run's tokens: its overlapping character pairs, or the run itself when it is one character. */
export function runBigrams(run: string): string[] {
  const chars = [...run]
  if (chars.length < 2) {
    return [run]
  }
  return chars.slice(1).map((char, index) => `${chars[index]}${char}`)
}

/**
 * What the `cjk` column holds for `text`, space-separated, in text order:
 * every run's character pairs plus its final character (so a single character
 * matches wherever it falls in a run), and every stretch of letters or digits
 * written against a run without a space.
 */
export function cjkColumnText(text: string): string {
  const chars = [...text]
  const tokens: string[] = []
  let index = 0
  while (index < chars.length) {
    const char = chars[index]!
    if (isUnsegmented(char)) {
      let end = index
      while (end < chars.length && isUnsegmented(chars[end]!)) {
        end += 1
      }
      tokens.push(...runBigrams(chars.slice(index, end).join('')))
      if (end - index > 1) {
        tokens.push(chars[end - 1]!)
      }
      index = end
    } else if (isSegmentChar(char)) {
      let end = index
      while (end < chars.length && isSegmentChar(chars[end]!)) {
        end += 1
      }
      const glued =
        (index > 0 && isUnsegmented(chars[index - 1]!)) ||
        (end < chars.length && isUnsegmented(chars[end]!))
      if (glued) {
        tokens.push(chars.slice(index, end).join(''))
      }
      index = end
    } else {
      index += 1
    }
  }
  return tokens.join(' ')
}
