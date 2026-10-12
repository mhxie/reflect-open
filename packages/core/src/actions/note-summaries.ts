import { languageModelFor, type TargetModel } from '../ai/language-model.ts'
import type { AiProvidersState } from '../ai/provider-config.ts'
import { aiApiKeyForConfig } from '../ai/secrets.ts'
import { pickSmallModelConfig } from '../ai/small-model.ts'
import { MAX_SUMMARY_SOURCE_CHARS, summarizeNote } from '../ai/summarize-note.ts'
import { errorMessage, isAppError, toAppError } from '../errors.ts'
import { readNoteLocal, writeNoteKeepingModified } from '../graph/commands.ts'
import { isLocalOnlyPath } from '../graph/local-only.ts'
import { db } from '../indexing/db.ts'
import { requestIndexReread } from '../indexing/live.ts'
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
  resolveOnDeviceTarget,
  verifyModelTarget,
  type CloudTarget,
  type VerifiedOnDeviceTarget,
} from '../privacy/on-device.ts'
import type { OnDeviceTarget } from '../privacy/on-device-target.ts'
import {
  sameSummariesModel,
  type AiProviderConfig,
  type AiProviderId,
  type AiSummariesModel,
  type AiSummaryMode,
} from '../settings/schema.ts'
import type { ReconcileStop } from './audio-memo.ts'

/**
 * The background AI summary pass: for each long note whose `aiSummary`
 * frontmatter block is missing or stale (the index's `summary_fresh`), ask a
 * model for a one-sentence summary and record it with the hash of the body it
 * describes. The index then shows it in the note's All Notes row.
 *
 * One engine per pass, as for audio-memo transcription. In `local` mode the
 * chosen (or first) attested on-device model, verified once per pass, takes
 * every note, private ones included. In `cloud` mode a public note goes to
 * the chosen cloud model (or the default provider's small model), through the
 * `cloudSafeNoteContent` gate on the note as read now, and a private note
 * keeps its snippet; until the user agrees to that exact entry and model
 * (`cloudConsent`), a cloud pass only counts what it would send.
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
  /** Which engine summarizes (`off` makes the pass a no-op). */
  mode: AiSummaryMode
  /**
   * The on-device model `local` mode uses (`aiSummariesLocalModel`); `null`
   * picks the default entry, then the first, that runs on this Mac.
   */
  localModel: AiSummariesModel | null
  /**
   * The cloud model `cloud` mode uses (`aiSummariesCloudModel`); `null` picks
   * the default provider's small model.
   */
  cloudModel: AiSummariesModel | null
  /**
   * The cloud entry and model the user agreed to (`aiSummariesCloudConsent`).
   * A `cloud` pass sends only to exactly these; otherwise it reads nothing and
   * reports what it would send, and where, as
   * {@link ReconcileNoteSummariesOutcome.consent}.
   */
  cloudConsent: AiSummariesModel | null
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
  /**
   * A `cloud` pass the user has not agreed to yet: how many public notes are
   * waiting and which provider would receive them. Nothing was read.
   */
  consent: NoteSummaryConsent | null
}

/** What a `cloud` pass asks the user before its first note leaves the Mac. */
export interface NoteSummaryConsent {
  notes: number
  provider: AiProviderId
  /** The provider entry and model the notes would go to; agreeing records them. */
  choice: AiSummariesModel
}

/** The `settled` key for a note: its path at one indexed revision. */
export function noteSummaryKey(path: string, fileHash: string): string {
  return `${fileHash}:${path}`
}

/** The engine a pass summarizes with, resolved once for its mode. */
type SummaryEngine =
  | { kind: 'local'; model: TargetModel<VerifiedOnDeviceTarget> }
  | {
      kind: 'cloud'
      model: TargetModel<CloudTarget>
      provider: AiProviderId
      choice: AiSummariesModel
    }

type ResolvedEngine = SummaryEngine | { kind: 'unavailable'; message: string }

/**
 * The on-device target `local` mode summarizes with: `choice` while its entry
 * is still attested for that model, or, with nothing chosen, the default
 * entry, then the first, that runs on this Mac. The Settings picker reads it
 * too.
 */
export function localSummaryTarget(
  providers: AiProvidersState,
  choice: AiSummariesModel | null,
): OnDeviceTarget | null {
  if (choice === null) {
    return pickOnDeviceProvider(providers)
  }
  const entry = providers.providers.find((config) => config.id === choice.configId)
  return entry === undefined ? null : resolveOnDeviceTarget({ ...entry, model: choice.modelId })
}

async function resolveLocalEngine(
  providers: AiProvidersState,
  choice: AiSummariesModel | null,
  fetchFn: typeof fetch,
): Promise<ResolvedEngine> {
  const target = localSummaryTarget(providers, choice)
  if (target === null) {
    return {
      kind: 'unavailable',
      message:
        choice === null
          ? 'No on-device model is configured for note summaries.'
          : 'The model chosen for note summaries no longer runs on this Mac.',
    }
  }
  const apiKey = await aiApiKeyForConfig(target.config)
  if (apiKey === null) {
    return { kind: 'unavailable', message: 'The on-device model is missing its API key.' }
  }
  try {
    const verified = await verifyModelTarget(target, apiKey)
    if (verified.kind !== 'on-device') {
      return { kind: 'unavailable', message: 'The on-device model could not be verified.' }
    }
    return { kind: 'local', model: await languageModelFor(verified, apiKey, fetchFn) }
  } catch (cause) {
    return { kind: 'unavailable', message: errorMessage(cause) }
  }
}

/**
 * The provider config `cloud` mode summarizes with: `choice`'s entry with its
 * model, or, with nothing chosen, the default provider's small model;
 * `'on-device'` when that runs on this Mac (`local` mode's to use, verified
 * first, so never reached here unverified), or `null` when there is none (the
 * chosen entry was removed, or no provider offers a small model). The
 * Settings picker and the go-ahead ask read it too.
 */
export function cloudSummaryConfig(
  providers: AiProvidersState,
  choice: AiSummariesModel | null,
): AiProviderConfig | 'on-device' | null {
  const config =
    choice === null ? pickSmallModelConfig(providers) : chosenConfig(providers.providers, choice)
  if (config === null) {
    return null
  }
  return resolveOnDeviceTarget(config) === null ? config : 'on-device'
}

function chosenConfig(
  providers: readonly AiProviderConfig[],
  choice: AiSummariesModel,
): AiProviderConfig | null {
  const entry = providers.find((config) => config.id === choice.configId)
  return entry === undefined ? null : { ...entry, model: choice.modelId }
}

/**
 * The entry and model `cloud` mode would send notes to now (see
 * {@link cloudSummaryConfig}), or `null` when it has none to use: what a
 * go-ahead must name exactly.
 */
export function cloudSummaryChoice(
  providers: AiProvidersState,
  choice: AiSummariesModel | null,
): AiSummariesModel | null {
  const config = cloudSummaryConfig(providers, choice)
  return config === null || config === 'on-device'
    ? null
    : { configId: config.id, modelId: config.model }
}

async function resolveCloudEngine(
  providers: AiProvidersState,
  choice: AiSummariesModel | null,
  fetchFn: typeof fetch,
): Promise<ResolvedEngine> {
  const config = cloudSummaryConfig(providers, choice)
  if (config === null) {
    return {
      kind: 'unavailable',
      message:
        choice === null
          ? 'No AI provider with a small model is configured for note summaries.'
          : 'The AI provider chosen for note summaries was removed.',
    }
  }
  const target = config === 'on-device' ? null : modelTarget(config)
  if (target?.kind !== 'cloud') {
    return {
      kind: 'unavailable',
      message:
        choice === null
          ? 'The default AI provider is on-device; choose On this Mac for note summaries.'
          : 'The model chosen for cloud summaries runs on this Mac; choose On this Mac instead.',
    }
  }
  const apiKey = await aiApiKeyForConfig(target.config)
  if (apiKey === null) {
    return { kind: 'unavailable', message: 'The AI provider is missing its API key.' }
  }
  return {
    kind: 'cloud',
    model: await languageModelFor(target, apiKey, fetchFn),
    provider: target.config.provider,
    choice: { configId: target.config.id, modelId: target.config.model },
  }
}

async function resolveEngine(input: ReconcileNoteSummariesInput): Promise<ResolvedEngine> {
  const fetchFn = input.fetchFn ?? fetch
  return input.mode === 'local'
    ? await resolveLocalEngine(input.providers, input.localModel, fetchFn)
    : await resolveCloudEngine(input.providers, input.cloudModel, fetchFn)
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

/** What happened to one note; `stop` ends the pass, and `later` leaves it for another. */
type NoteStep =
  | { kind: 'summarized' }
  | { kind: 'settled' }
  | { kind: 'later' }
  | { kind: 'stop'; stopped: ReconcileStop }

const STALE: ReconcileStop = { reason: 'stale', message: 'the graph session ended mid-pass' }

async function summarizeCandidate(
  candidate: SummaryCandidate,
  engine: SummaryEngine,
  input: ReconcileNoteSummariesInput,
): Promise<NoteStep> {
  const isStale = input.isStale ?? (() => false)
  let read: Awaited<ReturnType<typeof readNoteLocal>>
  try {
    // Bytes bound for the cloud refuse while sharing is paused.
    read = await readNoteLocal(candidate.path, input.generation, {
      sharing: engine.kind === 'cloud',
    })
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
    // Written, but the index never saw it (an earlier build's write, or a quit
    // before its echo landed). Only the index is asked to look again: nothing
    // is written now, so nothing else hears about it. Before the live index is
    // up, a later pass asks again.
    return requestIndexReread([candidate.path]) ? { kind: 'settled' } : { kind: 'later' }
  }

  const content = body.slice(0, MAX_SUMMARY_SOURCE_CHARS)
  let text: string | null
  if (engine.kind === 'local') {
    text = await summarizeNote({ model: engine.model, note: { title: parsed.title, content } })
  } else {
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
    text = await summarizeNote({ model: engine.model, note })
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
    consent: null,
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

    let engine: SummaryEngine | null = null
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
      if (engine === null) {
        const resolved = await resolveEngine(input)
        if (resolved.kind === 'unavailable') {
          outcome.stopped = { reason: 'config', message: resolved.message }
          return outcome
        }
        // The go-ahead names one entry and model: anything else, even another
        // model on the same entry, is asked about first.
        if (resolved.kind === 'cloud' && !sameSummariesModel(input.cloudConsent, resolved.choice)) {
          // Counted from the index alone: nothing is read before the user agrees.
          const notes = candidates.filter((waiting) => !isPrivateNote(waiting)).length
          outcome.consent =
            notes > 0 ? { notes, provider: resolved.provider, choice: resolved.choice } : null
          return outcome
        }
        engine = resolved
      }
      // In `cloud` mode a private note has nowhere to go; it is not even read.
      if (engine.kind === 'cloud' && isPrivateNote(candidate)) {
        continue
      }
      if (handled >= MAX_SUMMARIES_PER_PASS) {
        outcome.remaining = true
        return outcome
      }
      handled += 1
      const step = await summarizeCandidate(candidate, engine, input)
      if (step.kind === 'stop') {
        outcome.stopped = step.stopped
        return outcome
      }
      if (step.kind === 'summarized') {
        outcome.summarized += 1
      } else if (step.kind === 'settled') {
        outcome.settled.push(noteSummaryKey(candidate.path, candidate.fileHash))
      }
    }
  } catch (cause) {
    outcome.stopped = { reason: toAppError(cause).kind, message: errorMessage(cause) }
  }
  return outcome
}
