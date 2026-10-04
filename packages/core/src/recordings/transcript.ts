import { transcriptFallbackTitle } from '../ai/audio-memo-title.ts'
import { upsertFrontmatter } from '../markdown/frontmatter.ts'

/**
 * Transcript policy for the recorder. The microphone ("Me") and the
 * system audio ("Them") are transcribed as separate channels by native code;
 * this module turns the two timed segment lists into one transcript note:
 * drop Me segments that are residual speaker echo of Them, merge segments into
 * speaker turns, and render the note. Pure functions, no I/O.
 */

/** Which channel a segment came from: the microphone or the system audio. */
export type RecordingSpeaker = 'me' | 'them'

/** One transcribed span of a channel, timed from the start of the recording. */
export interface RecordingSegment {
  readonly startMs: number
  readonly endMs: number
  readonly speaker: RecordingSpeaker
  readonly text: string
}

/**
 * The smallest {@link textWeight} an echo candidate needs, about three English
 * words or four CJK characters. Short replies ("Yes", "可以") match almost any
 * sentence in order, so they are never treated as echo.
 */
export const ECHO_MIN_WEIGHT = 12

const ECHO_SCORE_THRESHOLD = 0.6
const ECHO_SLACK_MS = 2000
const TURN_GAP_MS = 1500

const LETTERS_AND_DIGITS = /[\p{L}\p{N}]/gu
const WIDE_SCRIPTS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
const FULLWIDTH_ASCII_FIRST = 0xff01
const FULLWIDTH_ASCII_LAST = 0xff5e

/**
 * East Asian Wide or Fullwidth, approximated by script (Han, kana, Hangul)
 * plus the fullwidth ASCII variants. Halfwidth kana and jamo share those
 * scripts and so count as wide too, a deliberate simplification for
 * characters speech recognition rarely emits.
 */
function isWideCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? 0
  return (
    WIDE_SCRIPTS.test(character) ||
    (codePoint >= FULLWIDTH_ASCII_FIRST && codePoint <= FULLWIDTH_ASCII_LAST)
  )
}

const SPEAKER_LABELS: Readonly<Record<RecordingSpeaker, string>> = { me: 'Me', them: 'Them' }

/** Lowercased letters and digits, one entry per code point. */
function normalizedCodePoints(text: string): string[] {
  return text.toLowerCase().match(LETTERS_AND_DIGITS) ?? []
}

function longestCommonSubsequence(first: readonly string[], second: readonly string[]): number {
  let previous = new Uint32Array(second.length + 1)
  for (const character of first) {
    const current = new Uint32Array(second.length + 1)
    for (let index = 0; index < second.length; index++) {
      current[index + 1] =
        character === second[index]
          ? (previous[index] ?? 0) + 1
          : Math.max(previous[index + 1] ?? 0, current[index] ?? 0)
    }
    previous = current
  }
  return previous[second.length] ?? 0
}

/**
 * Share of Me's letters and digits (lowercased) found in order inside the
 * Them text, from 0 to 1. Returns 0 when either side has no letters or digits.
 */
export function echoScore(me: string, them: string): number {
  const mine = normalizedCodePoints(me)
  const theirs = normalizedCodePoints(them)
  if (mine.length === 0 || theirs.length === 0) {
    return 0
  }
  // LCS is a slightly more permissive superset of difflib's matching blocks.
  return longestCommonSubsequence(mine, theirs) / mine.length
}

/**
 * How much speech `text` carries: its letters and digits, with East Asian
 * wide characters counting 3 and everything else 1.
 */
export function textWeight(text: string): number {
  let weight = 0
  for (const character of normalizedCodePoints(text)) {
    weight += isWideCharacter(character) ? 3 : 1
  }
  return weight
}

/** Tuning for {@link dropEchoRepeats}. */
export interface EchoFilterOptions {
  /** Minimum {@link echoScore} that marks a Me segment as echo. Defaults to 0.6. */
  readonly threshold?: number | undefined
  /** How far around a Me segment Them speech counts as nearby. Defaults to 2000. */
  readonly slackMs?: number | undefined
}

/**
 * Residual-echo safety net: drops Me segments that restate nearby Them speech.
 * Speakers leak the far end into the microphone, so a Me segment heavy enough
 * to judge ({@link ECHO_MIN_WEIGHT}) whose text mostly appears in the Them
 * segments around it is echo. Kept segments stay in input order.
 */
export function dropEchoRepeats(
  me: readonly RecordingSegment[],
  them: readonly RecordingSegment[],
  options: EchoFilterOptions = {},
): RecordingSegment[] {
  const threshold = options.threshold ?? ECHO_SCORE_THRESHOLD
  const slackMs = options.slackMs ?? ECHO_SLACK_MS
  return me.filter((segment) => {
    if (textWeight(segment.text) < ECHO_MIN_WEIGHT) {
      return true
    }
    const nearby = them
      .filter(
        (other) =>
          other.startMs < segment.endMs + slackMs && other.endMs > segment.startMs - slackMs,
      )
      .map((other) => other.text)
      .join(' ')
    return echoScore(segment.text, nearby) < threshold
  })
}

function isAsciiCodePoint(codePoint: number | undefined): boolean {
  return codePoint !== undefined && codePoint <= 0x7f
}

/** A space between Latin-script words; CJK text joins directly. */
function joinSeparator(previous: string, next: string): string {
  const lastCodePoint = previous.codePointAt(previous.length - 1)
  return isAsciiCodePoint(lastCodePoint) && isAsciiCodePoint(next.codePointAt(0)) ? ' ' : ''
}

function speakerOrder(speaker: RecordingSpeaker): number {
  return speaker === 'me' ? 0 : 1
}

/**
 * Chronological speaker turns: segments sorted by start (Me first on a tie),
 * with consecutive same-speaker segments at most `gapMs` apart joined into one
 * turn. Returns new segment objects.
 */
export function mergeTurns(
  segments: readonly RecordingSegment[],
  gapMs: number = TURN_GAP_MS,
): RecordingSegment[] {
  const sorted = [...segments].sort(
    (first, second) =>
      first.startMs - second.startMs || speakerOrder(first.speaker) - speakerOrder(second.speaker),
  )
  const turns: RecordingSegment[] = []
  for (const segment of sorted) {
    const last = turns.at(-1)
    if (
      last !== undefined &&
      last.speaker === segment.speaker &&
      segment.startMs - last.endMs <= gapMs
    ) {
      turns[turns.length - 1] = {
        startMs: last.startMs,
        endMs: Math.max(last.endMs, segment.endMs),
        speaker: last.speaker,
        text: last.text + joinSeparator(last.text, segment.text) + segment.text,
      }
    } else {
      turns.push({ ...segment })
    }
  }
  return turns
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0')
}

/** `HH:MM:SS` for an offset in milliseconds, flooring to whole seconds. */
export function formatClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor(totalSeconds / 60) % 60
  return `${pad(hours)}:${pad(minutes)}:${pad(totalSeconds % 60)}`
}

/** Graph-relative folder that holds every recording's transcript note. */
export const RECORDING_TRANSCRIPTS_DIR = 'inbox/recordings'

/** Everything derived from a recording's local start time. */
export interface RecordingIdentity {
  /** Unique basename, e.g. `recording-2026-07-01-090507`, also the note's alias. */
  readonly base: string
  /** Local ISO day of the recording, `YYYY-MM-DD`. */
  readonly date: string
  /** Local 24-hour start time, `HH:MM`. */
  readonly time: string
  /** Graph-relative path of the transcript note. */
  readonly notePath: string
}

/** The identity of a recording that started at `startedAt`, in local time. */
export function recordingIdentity(startedAt: Date): RecordingIdentity {
  const date = `${pad(startedAt.getFullYear(), 4)}-${pad(startedAt.getMonth() + 1)}-${pad(startedAt.getDate())}`
  const hours = pad(startedAt.getHours())
  const minutes = pad(startedAt.getMinutes())
  const base = `recording-${date}-${hours}${minutes}${pad(startedAt.getSeconds())}`
  return {
    base,
    date,
    time: `${hours}:${minutes}`,
    notePath: `${RECORDING_TRANSCRIPTS_DIR}/${base}.md`,
  }
}

/**
 * The transcript note's title: `<event> transcript <date>` when the recording
 * matched a calendar event; otherwise a memo's title, taken from the first
 * words of what was said (as on-device audio memos are titled), or
 * `Recording <date> <time>` when nothing was.
 */
export function recordingTitle(
  identity: RecordingIdentity,
  eventTitle: string | null,
  transcript: string,
): string {
  const event = eventTitle?.trim() ?? ''
  if (event !== '') {
    return `${event} transcript ${identity.date}`
  }
  return transcriptFallbackTitle(transcript, `Recording ${identity.date} ${identity.time}`)
}

/** Everything a transcript note records. */
export interface RecordingNoteInput {
  readonly identity: RecordingIdentity
  readonly title: string
  readonly durationMs: number
  /** The speech recognition model that produced the segments. */
  readonly model: string
  /** Where the recording's audio lives. */
  readonly audioPath: string
  /** The matched calendar event's title, or `null` when none matched. */
  readonly eventTitle: string | null
  readonly attendees: readonly string[]
  /** Capture problems worth surfacing, such as a silent system channel. */
  readonly warnings: readonly string[]
  readonly turns: readonly RecordingSegment[]
}

function turnParagraph(turn: RecordingSegment): string {
  return `**[${formatClock(turn.startMs)}] ${SPEAKER_LABELS[turn.speaker]}:** ${turn.text}`
}

/** Whether both channels spoke: only then do turns carry speaker labels. */
export function isConversation(turns: readonly RecordingSegment[]): boolean {
  return new Set(turns.map((turn) => turn.speaker)).size > 1
}

/**
 * The transcript note's Markdown: YAML frontmatter describing the recording
 * (optional keys appear only when they have a value), the title as an H1 the
 * way Reflect titles its notes, then a `## Transcript` section. A
 * conversation gets one timed, labeled paragraph per turn; a recording where
 * only one side spoke (a memo) reads as plain paragraphs. The base name is an
 * alias, so the daily-note link resolves even after the title is renamed.
 */
export function renderRecordingTranscript(input: RecordingNoteInput): string {
  const conversation = isConversation(input.turns)
  const paragraphs =
    input.turns.length === 0
      ? ['_No speech detected._']
      : input.turns.map((turn) => (conversation ? turnParagraph(turn) : turn.text))
  const body = `# ${input.title}\n\n## Transcript\n\n${paragraphs.join('\n\n')}\n`
  return upsertFrontmatter(body, {
    aliases: [input.identity.base],
    source: 'reflect-recording',
    recorded: `${input.identity.date} ${input.identity.time}`,
    duration: formatClock(input.durationMs),
    model: input.model,
    audio: input.audioPath,
    event: input.eventTitle ?? undefined,
    attendees: input.attendees.length > 0 ? [...input.attendees] : undefined,
    speakers: conversation ? 'Me = microphone, Them = system audio' : undefined,
    warnings: input.warnings.length > 0 ? [...input.warnings] : undefined,
  })
}
