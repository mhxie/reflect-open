import { languageModelFor, type TargetModel } from '../ai/language-model.ts'
import type { AiProvidersState } from '../ai/provider-config.ts'
import { aiApiKeyForConfig } from '../ai/secrets.ts'
import { pickSmallModelConfig } from '../ai/small-model.ts'
import { MAX_SUMMARY_SOURCE_CHARS, summarizeNote } from '../ai/summarize-note.ts'
import { errorMessage, isAppError, toAppError } from '../errors.ts'
import { readNoteLocal, writeNoteKeepingModified } from '../graph/commands.ts'
import { isLocalOnlyPath } from '../graph/local-only.ts'
import { db } from '../indexing/db.ts'
import {
  AI_SUMMARY_KEY,
  aiSummaryOwner,
  noteBodyHash,
  parseNote,
  splitFrontmatter,
  upsertFrontmatter,
  type AiSummaryFrontmatter,
} from '../markdown/index.ts'
import { cloudSafeNoteContent, isPrivateNote } from '../privacy/checkers.ts'
import {
  modelTarget,
  pickOnDeviceProvider,
  verifyModelTarget,
  type CloudTarget,
  type VerifiedOnDeviceTarget,
} from '../privacy/on-device.ts'
import type { AiSummaryMode } from '../settings/schema.ts'
import type { ReconcileStop } from './audio-memo.ts'

/**
 * The background AI summary pass: for each long note whose `aiSummary`
 * frontmatter block is missing or stale (the index's `summary_fresh`), ask a
 * model for a one-sentence summary and record it with the hash of the body it
 * describes. The index then shows it as the note's row preview.
 *
 * Local first: an attested on-device model, verified once per pass, takes
 * every note. Only in `local-and-cloud` mode, and only when no on-device
 * model answers, does a public note go to the default provider's small model,
 * through the `cloudSafeNoteContent` gate on the note as read now. A private
 * note is summarized on-device or not at all.
 *
 * The write keeps the file's modification time (a summary is not an edit) and
 * is checked against the bytes that were summarized: a note edited meanwhile
 * keeps the edit and is retried once its new body settles. Short notes keep
 * their plain snippet: they show most of themselves already.
 */

/** Display characters a note needs before it gets a summary instead of its snippet. */
export const MIN_SUMMARY_BODY_CHARS = 600

/**
 * How long a note must go unedited before it is summarized: a note being
 * written would otherwise be re-summarized after every pause, and a
 * frontmatter write must not land under the user's typing.
 */
export const SUMMARY_QUIET_MS = 5 * 60_000

/** Model calls per pass; the caller reschedules while `remaining` is set. */
const MAX_SUMMARIES_PER_PASS = 10

export interface ReconcileNoteSummariesInput {
  /** The configured-providers state, read once per pass. */
  providers: AiProvidersState
  /** Which models may summarize (`off` makes the pass a no-op). */
  mode: AiSummaryMode
  /** `GraphInfo.generation` — pins every read and write to the issuing graph. */
  generation: number
  /** Host transport for cloud calls (the Tauri HTTP plugin's fetch). */
  fetchFn?: typeof fetch
  /** Abort gate, checked between notes and after each slow await. */
  isStale?: () => boolean
  /** A note with unsaved edits open in an editor; skipped and retried later. */
  isBusy?: (path: string) => boolean
  /**
   * Notes this session already found it can't summarize ({@link noteSummaryKey}
   * of path and indexed file hash); skipped until the file changes.
   */
  settled?: ReadonlySet<string>
  /** Injectable clock (epoch ms) for the quiet period. */
  now?: () => number
}

export interface ReconcileNoteSummariesOutcome {
  /** Notes that needed a summary when the pass started. */
  pending: number
  /** Summaries written this pass. */
  summarized: number
  /**
   * {@link noteSummaryKey}s of notes handled without a summary at their
   * indexed revision — a model refusal, an `aiSummary` key someone else owns,
   * an evicted file, a note just marked private, an edit that raced the
   * write. The caller passes them back as `settled`; the next revision of the
   * file is tried afresh.
   */
  settled: string[]
  /** Eligible notes were left for another pass (the per-pass cap). */
  remaining: boolean
  /** When the earliest note held back by the quiet period (or busy) is due, or null. */
  nextDueAt: number | null
  /** Why the pass ended early, or `null` when it handled every eligible note. */
  stopped: ReconcileStop | null
}

/** The `settled` key for a note: its path at one indexed revision. */
export function noteSummaryKey(path: string, fileHash: string): string {
  return `${fileHash}:${path}`
}

/** The models a pass may use, resolved once: on-device first, cloud as the opt-in fallback. */
interface SummaryModels {
  local: TargetModel<VerifiedOnDeviceTarget> | null
  cloud: TargetModel<CloudTarget> | null
  /** Why neither model is usable, when that is the case. */
  unavailable: string
}

async function resolveLocalModel(
  providers: AiProvidersState,
  fetchFn: typeof fetch,
): Promise<TargetModel<VerifiedOnDeviceTarget> | string> {
  const target = pickOnDeviceProvider(providers)
  if (target === null) {
    return 'No on-device model is configured for note summaries.'
  }
  const apiKey = await aiApiKeyForConfig(target.config)
  if (apiKey === null) {
    return 'The on-device model is missing its API key.'
  }
  try {
    const verified = await verifyModelTarget(target, apiKey)
    if (verified.kind !== 'on-device') {
      return 'The on-device model could not be verified.'
    }
    return await languageModelFor(verified, apiKey, fetchFn)
  } catch (cause) {
    return errorMessage(cause)
  }
}

async function resolveCloudModel(
  providers: AiProvidersState,
  fetchFn: typeof fetch,
): Promise<TargetModel<CloudTarget> | null> {
  const config = pickSmallModelConfig(providers)
  if (config === null) {
    return null
  }
  const target = modelTarget(config)
  // An on-device entry was the local model's to answer for, verified; it is
  // never reached here unverified.
  if (target.kind !== 'cloud') {
    return null
  }
  const apiKey = await aiApiKeyForConfig(config)
  return apiKey === null ? null : await languageModelFor(target, apiKey, fetchFn)
}

async function resolveModels(input: ReconcileNoteSummariesInput): Promise<SummaryModels> {
  const fetchFn = input.fetchFn ?? fetch
  const local = await resolveLocalModel(input.providers, fetchFn)
  if (typeof local !== 'string') {
    return { local, cloud: null, unavailable: '' }
  }
  const cloud =
    input.mode === 'local-and-cloud' ? await resolveCloudModel(input.providers, fetchFn) : null
  return { local: null, cloud, unavailable: local }
}

interface SummaryCandidate {
  path: string
  fileHash: string
  mtime: number
  isPrivate: boolean
  hasDeviceOnlyContent: boolean
}

/** Long notes and dailies whose summary is missing or stale, newest first. */
async function summaryCandidates(): Promise<SummaryCandidate[]> {
  const rows = await db
    .selectFrom('notes')
    .select(['path', 'fileHash', 'mtime', 'isPrivate', 'hasDeviceOnlyContent'])
    .where('kind', 'in', ['note', 'daily'])
    .where('bodyChars', '>=', MIN_SUMMARY_BODY_CHARS)
    .where('summaryFresh', '=', 0)
    .orderBy('mtime', 'desc')
    .orderBy('path')
    .execute()
  return rows.map((row) => ({
    ...row,
    isPrivate: row.isPrivate !== 0,
    hasDeviceOnlyContent: row.hasDeviceOnlyContent !== 0,
  }))
}

/** What happened to one note; `stop` ends the pass. */
type NoteStep =
  | { kind: 'summarized' }
  | { kind: 'settled' }
  | { kind: 'stop'; stopped: ReconcileStop }

const STALE: ReconcileStop = { reason: 'stale', message: 'the graph session ended mid-pass' }

async function summarizeCandidate(
  candidate: SummaryCandidate,
  models: SummaryModels,
  input: ReconcileNoteSummariesInput,
): Promise<NoteStep> {
  const isStale = input.isStale ?? (() => false)
  let read: Awaited<ReturnType<typeof readNoteLocal>>
  try {
    read = await readNoteLocal(candidate.path, input.generation)
  } catch (cause) {
    if (isAppError(cause) && cause.kind === 'notFound') {
      return { kind: 'settled' } // deleted since it was indexed
    }
    throw cause
  }
  if (isStale()) {
    return { kind: 'stop', stopped: STALE }
  }
  if (read.kind === 'evicted' || read.localOnly) {
    return { kind: 'settled' }
  }
  const source = read.content
  if (aiSummaryOwner(source) === 'foreign') {
    return { kind: 'settled' }
  }
  const parsed = parseNote({ path: candidate.path, source })
  const body = splitFrontmatter(source).body
  const hash = noteBodyHash(body)
  if (parsed.frontmatter.aiSummary?.hash === hash) {
    return { kind: 'settled' } // already written; the index catches up on the echo
  }

  const content = body.slice(0, MAX_SUMMARY_SOURCE_CHARS)
  let text: string | null
  if (models.local !== null) {
    text = await summarizeNote({ model: models.local, note: { title: parsed.title, content } })
  } else if (models.cloud !== null) {
    // The live flag, re-read with the source: the index can lag a note
    // marked private moments ago.
    if (parsed.frontmatter.private || isPrivateNote(candidate)) {
      return { kind: 'settled' } // marked private since it was indexed
    }
    const note = cloudSafeNoteContent({
      path: candidate.path,
      isPrivate: parsed.frontmatter.private,
      hasDeviceOnlyContent: candidate.hasDeviceOnlyContent,
      title: parsed.title,
      content,
      truncated: content.length < body.length,
    })
    text = await summarizeNote({ model: models.cloud, note })
  } else {
    return { kind: 'settled' }
  }
  if (isStale()) {
    return { kind: 'stop', stopped: STALE }
  }
  if (text === null) {
    return { kind: 'settled' }
  }

  const summary: AiSummaryFrontmatter = { text, hash }
  const next = upsertFrontmatter(source, { [AI_SUMMARY_KEY]: summary })
  try {
    await writeNoteKeepingModified(candidate.path, next, input.generation, source)
  } catch (cause) {
    if (isAppError(cause) && (cause.kind === 'io' || cause.kind === 'notFound')) {
      return { kind: 'settled' } // changed on disk meanwhile: the edit wins, retried at its revision
    }
    throw cause
  }
  return { kind: 'summarized' }
}

/**
 * Summarize the long notes that lack a current summary, up to a per-pass cap.
 * Idempotent: a note whose block already matches its body is never sent.
 * Never throws; failures end the pass as `stopped`.
 */
export async function reconcileNoteSummaries(
  input: ReconcileNoteSummariesInput,
): Promise<ReconcileNoteSummariesOutcome> {
  const outcome: ReconcileNoteSummariesOutcome = {
    pending: 0,
    summarized: 0,
    settled: [],
    remaining: false,
    nextDueAt: null,
    stopped: null,
  }
  if (input.mode === 'off') {
    return outcome
  }
  const isStale = input.isStale ?? (() => false)
  const now = input.now ?? Date.now
  try {
    const candidates = (await summaryCandidates()).filter(
      (candidate) =>
        !isLocalOnlyPath(candidate.path) &&
        input.settled?.has(noteSummaryKey(candidate.path, candidate.fileHash)) !== true,
    )
    outcome.pending = candidates.length
    if (candidates.length === 0 || isStale()) {
      return outcome
    }

    let models: SummaryModels | null = null
    let handled = 0
    for (const candidate of candidates) {
      if (isStale()) {
        outcome.stopped = STALE
        return outcome
      }
      const dueAt = candidate.mtime + SUMMARY_QUIET_MS
      const busy = input.isBusy?.(candidate.path) === true
      if (busy || dueAt > now()) {
        const retryAt = busy ? now() + SUMMARY_QUIET_MS : dueAt
        outcome.nextDueAt = Math.min(outcome.nextDueAt ?? retryAt, retryAt)
        continue
      }
      models ??= await resolveModels(input)
      if (models.local === null && models.cloud === null) {
        outcome.stopped = { reason: 'config', message: models.unavailable }
        return outcome
      }
      // Without an on-device model a private note has nowhere to go; it is
      // not even read.
      if (models.local === null && isPrivateNote(candidate)) {
        continue
      }
      if (handled >= MAX_SUMMARIES_PER_PASS) {
        outcome.remaining = true
        return outcome
      }
      handled += 1
      const step = await summarizeCandidate(candidate, models, input)
      if (step.kind === 'stop') {
        outcome.stopped = step.stopped
        return outcome
      }
      if (step.kind === 'summarized') {
        outcome.summarized += 1
      } else {
        outcome.settled.push(noteSummaryKey(candidate.path, candidate.fileHash))
      }
    }
  } catch (cause) {
    outcome.stopped = { reason: toAppError(cause).kind, message: errorMessage(cause) }
  }
  return outcome
}
