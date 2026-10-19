import type { MaybePromise } from '@reflect/utils'
import type { AiCredentialService } from '../ai/ai-credential-service.ts'
import type { AiProviderConfigService } from '../ai/ai-provider-config-service.ts'
import type { LanguageModelService, TargetModel } from '../ai/language-model-service.ts'
import type { OnDeviceModelService } from '../ai/on-device-model-service.ts'
import type { AiProvidersState } from '../ai/provider-config.ts'
import { pickSmallModelConfig } from '../ai/small-model.ts'
import { MAX_SUMMARY_SOURCE_CHARS, summarizeNote } from '../ai/summarize-note.ts'
import type { OpenDocumentsService } from '../documents/open-documents-service.ts'
import { errorMessage, isAppError, toAppError } from '../errors.ts'
import {
  requireGraphSession,
  type GraphRole,
  type GraphSession,
  type GraphSessionSource,
} from '../graph/graph-session.ts'
import { isLocalOnlyPath, type LocalOnlyFolders } from '../graph/local-only.ts'
import type { LocalNoteRead, NoteFileService } from '../graph/note-file-service.ts'
import { isNotePath } from '../graph/paths.ts'
import type { DatabaseService } from '../indexing/database-service.ts'
import type { IndexLifecycleService } from '../indexing/index-lifecycle-service.ts'
import {
  AI_SUMMARY_KEY,
  aiSummaryOwner,
  noteBodyHash,
  parseNote,
  splitFrontmatter,
  upsertFrontmatter,
  type AiSummaryFrontmatter,
} from '../markdown/index.ts'
import type { ClockService, TimerHandle } from '../ports/clock-service.ts'
import type { LoggerService } from '../ports/logger-service.ts'
import {
  modelTarget,
  pickOnDeviceProvider,
  resolveOnDeviceTarget,
  type CloudTarget,
  type VerifiedOnDeviceTarget,
} from '../privacy/on-device.ts'
import type { OnDeviceTarget } from '../privacy/on-device-target.ts'
import { cloudSafeNoteContent, isPrivateNote } from '../privacy/privacy-service.ts'
import type {
  BackgroundReconciler,
  BackgroundReconcilerFactory,
} from '../reconcile/background-reconciler.ts'
import { isSilentStop, type ReconcileStop } from '../reconcile/reconcile.ts'
import {
  sameSummariesModel,
  type AiProviderConfig,
  type AiProviderId,
  type AiSummariesModel,
  type AiSummaryMode,
} from '../settings/schema.ts'
import type { SettingsService } from '../settings/settings-service.ts'

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
 * (`aiSummariesCloudConsent`), a cloud pass only counts what it would send.
 * Notes in a local-only folder are never summarized.
 *
 * The write keeps the file's modification time (a summary is not an edit) and
 * is checked against the bytes that were summarized: a note edited meanwhile
 * keeps the edit and is retried once its new body settles. Short notes keep
 * their plain snippet: they show most of themselves already.
 *
 * A pass first catches up with other devices (`catchUp`), skipping what they
 * summarized; the sync merge keeps a body's first summary (`generatedAt`).
 */

/**
 * Display characters a note needs before it gets a summary instead of its snippet.
 */
export const MIN_SUMMARY_BODY_CHARS = 600

/**
 * How long a note must go unedited before it is summarized: a note being
 * written would otherwise be re-summarized after every pause, and a
 * frontmatter write must not land under the user's typing.
 */
export const SUMMARY_QUIET_MS = 5 * 60_000

/**
 * Model calls per pass; the session reschedules while `remaining` is set.
 */
const MAX_SUMMARIES_PER_PASS = 10

/**
 * How long a `config` stop (no usable model) holds the session off, unless
 * the mode, the chosen models or the providers change: saves must not
 * re-probe a local server that isn't running.
 */
const CONFIG_BACKOFF_MS = 10 * 60_000

/**
 * Floor for the quiet-period timer, so a due-now note can't spin it.
 */
const MIN_TIMER_MS = 1_000

/**
 * How long a pass waits for its catch-up before summarizing without it.
 */
const CATCH_UP_TIMEOUT_MS = 30_000

export interface ReconcileNoteSummariesInput {
  /**
   * The configured-providers state, read once per pass.
   */
  providers: AiProvidersState
  /**
   * Which engine summarizes (`off` makes the pass a no-op).
   */
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
  /**
   * `GraphInfo.generation`: pins every read and write to the issuing graph.
   * A pass for a graph that is no longer open stops as `stale`.
   */
  generation: number
  /**
   * Abort gate, checked between notes and after each slow await.
   */
  isStale?: () => boolean
  /**
   * A note with unsaved edits open in an editor; skipped and retried later.
   */
  isBusy?: (path: string) => boolean
  /**
   * Notes this session already found it can't summarize ({@link noteSummaryKey}
   * of path and indexed file hash); skipped until the file changes.
   */
  settled?: ReadonlySet<string>
  /**
   * Pulls other devices' changes, awaited before the first model call; a failure, or
   * 30 s without an answer, leaves the pass to go on without them.
   */
  catchUp?: () => MaybePromise<void>
}

export interface ReconcileNoteSummariesOutcome {
  /**
   * Notes that needed a summary when the pass started.
   */
  pending: number
  /**
   * Summaries written this pass.
   */
  summarized: number
  /**
   * {@link noteSummaryKey}s of notes handled without a summary at their
   * indexed revision: a model refusal, an `aiSummary` key someone else owns,
   * an evicted file, a note just marked private, an edit that raced the
   * write. The caller passes them back as `settled`; the next revision of the
   * file is tried afresh.
   */
  settled: string[]
  /**
   * Eligible notes were left for another pass (the per-pass cap).
   */
  remaining: boolean
  /**
   * When the earliest note held back by the quiet period (or busy) is due, or null.
   */
  nextDueAt: number | null
  /**
   * Why the pass ended early, or `null` when it handled every eligible note.
   */
  stopped: ReconcileStop | null
  /**
   * A `cloud` pass the user has not agreed to yet: how many public notes are
   * waiting and which provider would receive them. Nothing was read.
   */
  consent: NoteSummaryConsent | null
}

/**
 * What a `cloud` pass asks the user before its first note leaves the Mac.
 */
export interface NoteSummaryConsent {
  notes: number
  provider: AiProviderId
  /**
   * The provider entry and model the notes would go to; agreeing records them.
   */
  choice: AiSummariesModel
}

/**
 * The `settled` key for a note: its path at one indexed revision.
 */
export function noteSummaryKey(path: string, fileHash: string): string {
  return `${fileHash}:${path}`
}

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

export interface NoteSummarySessionOptions {
  /**
   * A cloud pass is waiting for the user's go-ahead. Called once per session
   * and model; a change of the summary settings may ask again.
   */
  onConsentNeeded: (consent: NoteSummaryConsent) => void
  /**
   * The graph's pull (`BackupService.catchUp`), handed to the first pass of each burst.
   */
  catchUp?: () => MaybePromise<void>
}

/**
 * The AI note-summary lifecycle for one graph session. A pass runs at launch
 * (the backfill), after every indexed note change, on focus or online, when
 * the summary settings or providers change, and when the quiet period of a
 * note held back for recent edits runs out. Each pass summarizes a bounded
 * batch and queues a follow-up while more remain; settings are read at the
 * start of every pass.
 *
 * Notes a pass could not summarize at their indexed revision are remembered
 * for the session, so a refusal is never re-sent until the note changes. A
 * missing model (`config`) holds the session off for ten minutes unless the
 * summary settings or providers change. In a note window it does nothing:
 * two summarizers would double-bill and race the writes.
 */
export interface NoteSummarySession {
  /**
   * Attach the triggers and run the launch pass.
   */
  start(): void
  /**
   * Tear down triggers and timers; abort an in-flight pass at its next gate.
   */
  dispose(): void
}

export interface NoteSummaryServiceDeps {
  readonly database: DatabaseService
  readonly noteFile: NoteFileService
  readonly indexLifecycle: IndexLifecycleService
  readonly openDocuments: OpenDocumentsService
  readonly aiProviderConfig: AiProviderConfigService
  readonly aiCredentials: AiCredentialService
  readonly onDeviceModels: OnDeviceModelService
  readonly languageModel: LanguageModelService
  readonly settings: SettingsService
  readonly reconcilers: BackgroundReconcilerFactory
  readonly clock: ClockService
  readonly role: GraphRole
  readonly graphSession: GraphSessionSource
  readonly logger: LoggerService
}

/**
 * One-sentence AI summaries of long notes, written into their `aiSummary`
 * frontmatter for the All Notes list (see the module doc for the privacy
 * contract).
 */
export interface NoteSummaryService {
  /**
   * Summarize the long notes that lack a current summary, up to a per-pass
   * cap. Idempotent: a note whose block already matches its body is never
   * sent. Never throws; failures end the pass as `stopped`.
   */
  reconcile(input: ReconcileNoteSummariesInput): Promise<ReconcileNoteSummariesOutcome>
  /**
   * Build the summary lifecycle for the open graph's session; throws when no
   * graph is open. `dispose()` is terminal.
   */
  openSession(options: NoteSummarySessionOptions): NoteSummarySession
}

/**
 * The engine a pass summarizes with, resolved once for its mode.
 */
type SummaryEngine =
  | { kind: 'local'; model: TargetModel<VerifiedOnDeviceTarget> }
  | {
      kind: 'cloud'
      model: TargetModel<CloudTarget>
      provider: AiProviderId
      choice: AiSummariesModel
    }

type ResolvedEngine = SummaryEngine | { kind: 'unavailable'; message: string }

interface SummaryCandidate {
  path: string
  fileHash: string
  mtime: number
  isPrivate: boolean
  hasDeviceOnlyContent: boolean
}

/**
 * What happened to one note; `stop` ends the pass, and `later` leaves it for another.
 */
type NoteStep =
  | { kind: 'summarized' }
  | { kind: 'settled' }
  | { kind: 'later' }
  | { kind: 'stop'; stopped: ReconcileStop }

const STALE: ReconcileStop = { reason: 'stale', message: 'the graph session ended mid-pass' }

class NoteSummaryServiceImpl implements NoteSummaryService {
  readonly #deps: NoteSummaryServiceDeps

  constructor(deps: NoteSummaryServiceDeps) {
    this.#deps = deps
  }

  async reconcile(input: ReconcileNoteSummariesInput): Promise<ReconcileNoteSummariesOutcome> {
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
    const { session } = this.#deps.graphSession.getState()
    if (session === null || session.generation !== input.generation) {
      // The local-only folders are the open graph's: another graph's pass
      // could not tell which of its notes stay on the device.
      outcome.stopped = STALE
      return outcome
    }
    const { localOnly } = session
    const isStale = input.isStale ?? (() => false)
    const { clock } = this.#deps
    try {
      const candidates = (await this.#candidates()).filter((candidate) => {
        return (
          !isLocalOnlyPath(localOnly, candidate.path) &&
          input.settled?.has(noteSummaryKey(candidate.path, candidate.fileHash)) !== true
        )
      })
      outcome.pending = candidates.length
      if (candidates.length === 0 || isStale()) {
        return outcome
      }

      // A note open with edits, or edited within the quiet period, waits; true when it does.
      const putOff = (candidate: SummaryCandidate): boolean => {
        const dueAt = candidate.mtime + SUMMARY_QUIET_MS
        const busy = input.isBusy?.(candidate.path) === true
        if (!busy && dueAt <= clock.now()) {
          return false
        }
        const retryAt = busy ? clock.now() + SUMMARY_QUIET_MS : dueAt
        outcome.nextDueAt = Math.min(outcome.nextDueAt ?? retryAt, retryAt)
        return true
      }
      let engine: SummaryEngine | null = null
      let handled = 0
      let { catchUp } = input
      for (const candidate of candidates) {
        if (isStale()) {
          outcome.stopped = STALE
          return outcome
        }
        if (putOff(candidate)) {
          continue
        }
        if (engine === null) {
          const resolved = await this.#resolveEngine(input)
          if (resolved.kind === 'unavailable') {
            outcome.stopped = { reason: 'config', message: resolved.message }
            return outcome
          }
          // The go-ahead names one entry and model: anything else, even another
          // model on the same entry, is asked about first.
          if (
            resolved.kind === 'cloud' &&
            !sameSummariesModel(input.cloudConsent, resolved.choice)
          ) {
            // Counted from the index alone: nothing is read before the user agrees.
            const notes = candidates.filter((waiting) => !isPrivateNote(localOnly, waiting)).length
            outcome.consent =
              notes > 0 ? { notes, provider: resolved.provider, choice: resolved.choice } : null
            return outcome
          }
          engine = resolved
        }
        // In `cloud` mode a private note has nowhere to go; it is not even read.
        if (engine.kind === 'cloud' && isPrivateNote(localOnly, candidate)) {
          continue
        }
        if (handled >= MAX_SUMMARIES_PER_PASS) {
          outcome.remaining = true
          return outcome
        }
        if (catchUp !== undefined) {
          await this.#catchUp(catchUp)
          catchUp = undefined
          if (isStale()) {
            outcome.stopped = STALE
            return outcome
          }
          // The catch-up can take a while: the note may be open with edits by now.
          if (putOff(candidate)) {
            continue
          }
        }
        handled += 1
        const step = await this.#summarize(candidate, engine, input, localOnly)
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

  openSession(options: NoteSummarySessionOptions): NoteSummarySession {
    return new NoteSummarySessionImpl(
      {
        indexLifecycle: this.#deps.indexLifecycle,
        openDocuments: this.#deps.openDocuments,
        aiProviderConfig: this.#deps.aiProviderConfig,
        settings: this.#deps.settings,
        reconcilers: this.#deps.reconcilers,
        clock: this.#deps.clock,
        logger: this.#deps.logger,
        mainWindow: this.#deps.role === 'main',
        reconcile: (input) => this.reconcile(input),
      },
      requireGraphSession(this.#deps.graphSession),
      options,
    )
  }

  /**
   * Await `catchUp` for at most {@link CATCH_UP_TIMEOUT_MS}; a failure is logged, not thrown.
   */
  async #catchUp(catchUp: () => MaybePromise<void>): Promise<void> {
    const { clock, logger } = this.#deps
    let timer: TimerHandle | undefined
    const timedOut = new Promise<true>((resolve) => {
      timer = clock.setTimeout(() => {
        resolve(true)
      }, CATCH_UP_TIMEOUT_MS)
    })
    try {
      if ((await Promise.race([Promise.resolve().then(catchUp), timedOut])) === true) {
        logger.info('note summaries: catching up with other devices timed out; going on without')
      }
    } catch (cause) {
      logger.warn('note summaries: catching up with other devices failed:', errorMessage(cause))
    } finally {
      if (timer !== undefined) {
        clock.clearTimeout(timer)
      }
    }
  }

  /**
   * Long notes and dailies whose summary is missing or stale, newest first.
   */
  async #candidates(): Promise<SummaryCandidate[]> {
    const rows = await this.#deps.database.db
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

  async #resolveEngine(input: ReconcileNoteSummariesInput): Promise<ResolvedEngine> {
    return input.mode === 'local'
      ? await this.#resolveLocalEngine(input.providers, input.localModel)
      : await this.#resolveCloudEngine(input.providers, input.cloudModel)
  }

  async #resolveLocalEngine(
    providers: AiProvidersState,
    choice: AiSummariesModel | null,
  ): Promise<ResolvedEngine> {
    const { aiCredentials, onDeviceModels, languageModel } = this.#deps
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
    const apiKey = await aiCredentials.read(target.config)
    if (apiKey === null) {
      return { kind: 'unavailable', message: 'The on-device model is missing its API key.' }
    }
    try {
      const verified = await onDeviceModels.verify(target, apiKey)
      if (verified.kind !== 'on-device') {
        return { kind: 'unavailable', message: 'The on-device model could not be verified.' }
      }
      return { kind: 'local', model: await languageModel.createFor(verified, apiKey) }
    } catch (cause) {
      return { kind: 'unavailable', message: errorMessage(cause) }
    }
  }

  async #resolveCloudEngine(
    providers: AiProvidersState,
    choice: AiSummariesModel | null,
  ): Promise<ResolvedEngine> {
    const { aiCredentials, languageModel } = this.#deps
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
    const apiKey = await aiCredentials.read(target.config)
    if (apiKey === null) {
      return { kind: 'unavailable', message: 'The AI provider is missing its API key.' }
    }
    return {
      kind: 'cloud',
      model: await languageModel.createFor(target, apiKey),
      provider: target.config.provider,
      choice: { configId: target.config.id, modelId: target.config.model },
    }
  }

  async #summarize(
    candidate: SummaryCandidate,
    engine: SummaryEngine,
    input: ReconcileNoteSummariesInput,
    localOnly: LocalOnlyFolders,
  ): Promise<NoteStep> {
    const { noteFile, indexLifecycle } = this.#deps
    const isStale = input.isStale ?? (() => false)
    let read: LocalNoteRead
    try {
      // Bytes bound for the cloud refuse while sharing is paused.
      read = await noteFile.readLocal(candidate.path, input.generation, {
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
      return indexLifecycle.requestReread([candidate.path])
        ? { kind: 'settled' }
        : { kind: 'later' }
    }

    const content = body.slice(0, MAX_SUMMARY_SOURCE_CHARS)
    let text: string | null
    if (engine.kind === 'local') {
      text = await summarizeNote({ model: engine.model, note: { title: parsed.title, content } })
    } else {
      // The live flag, re-read with the source: the index can lag a note
      // marked private moments ago.
      if (parsed.frontmatter.private || isPrivateNote(localOnly, candidate)) {
        return { kind: 'settled' } // marked private since it was indexed
      }
      const note = cloudSafeNoteContent(localOnly, {
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

    const generatedAt = new Date(this.#deps.clock.now()).toISOString()
    const summary: AiSummaryFrontmatter = { text, hash, generatedAt }
    const next = upsertFrontmatter(source, { [AI_SUMMARY_KEY]: summary })
    try {
      await noteFile.writeKeepingModified(candidate.path, next, input.generation, source)
    } catch (cause) {
      if (isAppError(cause) && (cause.kind === 'io' || cause.kind === 'notFound')) {
        return { kind: 'settled' } // changed on disk meanwhile: the edit wins, retried at its revision
      }
      throw cause
    }
    return { kind: 'summarized' }
  }
}

interface NoteSummarySessionDeps {
  readonly indexLifecycle: IndexLifecycleService
  readonly openDocuments: OpenDocumentsService
  readonly aiProviderConfig: AiProviderConfigService
  readonly settings: SettingsService
  readonly reconcilers: BackgroundReconcilerFactory
  readonly clock: ClockService
  readonly logger: LoggerService
  readonly mainWindow: boolean
  readonly reconcile: (input: ReconcileNoteSummariesInput) => Promise<ReconcileNoteSummariesOutcome>
}

class NoteSummarySessionImpl implements NoteSummarySession {
  readonly #deps: NoteSummarySessionDeps
  readonly #session: GraphSession
  readonly #options: NoteSummarySessionOptions
  readonly #loop: BackgroundReconciler
  #started = false
  /**
   * {@link noteSummaryKey}s this session could not summarize at their revision.
   */
  #settled = new Set<string>()
  #timer: TimerHandle | null = null
  /**
   * A `config` stop: the settings it held for, and until when.
   */
  #blocked: { snapshot: string; until: number } | null = null
  #loggedStop: string | null = null
  /**
   * The model the open ask names; a pass naming another asks again.
   */
  #askedChoice: AiSummariesModel | null = null
  /**
   * The last pass left a backlog: its continuation does not catch up again.
   */
  #continuing = false
  /**
   * The summary settings and providers the session last saw.
   */
  #seen: string
  /**
   * The go-ahead and whether summaries are on, as the session last saw them:
   * a change of either starts the session over.
   */
  #seenConsent: string

  constructor(
    deps: NoteSummarySessionDeps,
    session: GraphSession,
    options: NoteSummarySessionOptions,
  ) {
    this.#deps = deps
    this.#session = session
    this.#options = options
    this.#loop = deps.reconcilers.create({ pass: (isStale) => this.#pass(isStale) })
    this.#loop.onDispose(() => {
      this.#clearTimer()
    })
    this.#seen = this.#snapshot()
    this.#seenConsent = this.#consentSnapshot()
  }

  start(): void {
    const { indexLifecycle, settings } = this.#deps
    if (!this.#deps.mainWindow || this.#started || this.#loop.isStale()) {
      return
    }
    this.#started = true
    this.#loop.retryOnWake()
    // The post-apply signal, so a pass reads a settled index: the note's
    // privacy flag and body length are already projected when it runs.
    const indexGeneration = this.#session.indexGeneration
    this.#loop.onDispose(
      indexLifecycle.onApplied((event) => {
        if (event.generation !== indexGeneration) {
          return
        }
        if (
          event.changes === null ||
          event.changes.some((change) => change.kind === 'upsert' && isNotePath(change.path))
        ) {
          this.#loop.schedule()
        }
      }),
    )
    // A model chosen after a pass found none would otherwise wait for the
    // next note change or focus.
    this.#loop.onDispose(
      settings.subscribe(() => {
        this.#followSettings()
      }),
    )
    this.#loop.schedule()
  }

  dispose(): void {
    this.#loop.dispose()
  }

  /**
   * The summary settings and providers a pass reads, as a key.
   */
  #snapshot(): string {
    const current = this.#deps.settings.get()
    return JSON.stringify([
      current.aiSummaries,
      this.#deps.aiProviderConfig.state(),
      current.aiSummariesLocalModel,
      current.aiSummariesCloudModel,
      current.aiSummariesCloudConsent,
    ])
  }

  #consentSnapshot(): string {
    const current = this.#deps.settings.get()
    return JSON.stringify([current.aiSummaries === 'off', current.aiSummariesCloudConsent])
  }

  /**
   * A changed mode, model or provider runs a pass now, asking again if a
   * go-ahead is still needed (the change may have withdrawn the open ask).
   * A new go-ahead, or summaries turned on or off, starts over: what this
   * session settled was settled for another engine.
   */
  #followSettings(): void {
    const snapshot = this.#snapshot()
    if (snapshot === this.#seen) {
      return
    }
    this.#seen = snapshot
    const consent = this.#consentSnapshot()
    if (consent !== this.#seenConsent) {
      this.#seenConsent = consent
      this.#settled = new Set()
      this.#blocked = null
      this.#continuing = false
      this.#clearTimer()
    }
    this.#askedChoice = null
    this.#loop.schedule()
  }

  #surfaceStop(stopped: ReconcileStop | null): void {
    if (stopped === null) {
      this.#loggedStop = null
      return
    }
    if (isSilentStop(stopped) || this.#loggedStop === stopped.message) {
      return
    }
    this.#loggedStop = stopped.message
    this.#deps.logger.warn(`note summaries stopped (${stopped.reason}): ${stopped.message}`)
  }

  #scheduleAt(dueAt: number): void {
    const { clock } = this.#deps
    this.#clearTimer()
    this.#timer = clock.setTimeout(
      () => {
        this.#timer = null
        this.#loop.schedule()
      },
      Math.max(MIN_TIMER_MS, dueAt - clock.now()),
    )
  }

  #clearTimer(): void {
    if (this.#timer !== null) {
      this.#deps.clock.clearTimeout(this.#timer)
      this.#timer = null
    }
  }

  async #pass(isStale: () => boolean): Promise<void | 'stop'> {
    const { settings, aiProviderConfig, openDocuments, clock, reconcile } = this.#deps
    const continuing = this.#continuing
    this.#continuing = false
    const current = settings.get()
    const mode = current.aiSummaries
    if (mode === 'off') {
      return
    }
    const passSnapshot = this.#snapshot()
    if (
      this.#blocked !== null &&
      this.#blocked.snapshot === passSnapshot &&
      clock.now() < this.#blocked.until
    ) {
      return
    }
    this.#blocked = null
    const passIsStale = (): boolean => isStale() || this.#snapshot() !== passSnapshot
    const { generation } = this.#session
    const catchUp = continuing ? undefined : this.#options.catchUp
    const outcome = await reconcile({
      providers: aiProviderConfig.state(),
      mode,
      localModel: current.aiSummariesLocalModel,
      cloudModel: current.aiSummariesCloudModel,
      cloudConsent: current.aiSummariesCloudConsent,
      generation,
      isStale: passIsStale,
      isBusy: (path) => openDocuments.sessionFor(path, generation)?.isDirty() === true,
      settled: this.#settled,
      ...(catchUp === undefined ? {} : { catchUp }),
    })
    this.#continuing = outcome.remaining
    for (const key of outcome.settled) {
      this.#settled.add(key)
    }
    this.#surfaceStop(outcome.stopped)
    const consent = outcome.consent
    if (consent !== null && !sameSummariesModel(consent.choice, this.#askedChoice) && !isStale()) {
      this.#askedChoice = consent.choice
      this.#options.onConsentNeeded(consent)
    }
    if (outcome.nextDueAt !== null && !isStale()) {
      this.#scheduleAt(outcome.nextDueAt)
    }
    if (outcome.stopped?.reason === 'config') {
      this.#blocked = { snapshot: passSnapshot, until: clock.now() + CONFIG_BACKOFF_MS }
      return 'stop'
    }
    if (outcome.stopped !== null) {
      return 'stop' // transient: the next trigger retries
    }
    if (outcome.remaining) {
      this.#loop.schedule()
    }
  }
}

export function createNoteSummaryService(deps: NoteSummaryServiceDeps): NoteSummaryService {
  return new NoteSummaryServiceImpl(deps)
}
