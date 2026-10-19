import {
  isSessionReady,
  partTranscriptName,
  decodePartResult,
  encodePartResult,
  groupAudioMemoSessions,
  stitchSessionTranscript,
  type AudioMemoIdentity,
  type AudioMemoPart,
  type AudioMemoPartResult,
  type AudioMemoSession,
  type SegmentTranscriber,
} from './audio-memo-session.ts'
import { audioMemoFromPath, audioMemoPartFromPath } from './audio-memo.ts'
import { cloudSegmentTranscriber, localSegmentTranscriber } from './audio-memo-transcribers.ts'
import type { AiCredentialService } from '../ai/ai-credential-service.ts'
import type { AiProviderConfigService } from '../ai/ai-provider-config-service.ts'
import type { LocalTranscriptionModelId } from '../ai/local-transcription-models.ts'
import type { LocalTranscriptionService } from '../ai/local-transcription-service.ts'
import { smallModelConfig } from '../ai/small-model.ts'
import { isTranscriptionOversize, isTranscriptionRejected } from '../ai/transcribe-http.ts'
import type {
  AudioMemoEnrichmentCredentials,
  TranscriptEnrichmentService,
} from '../ai/transcript-enrichment-service.ts'
import type { TranscriptionService } from '../ai/transcription-service.ts'
import type { BackgroundReconcilerFactory } from '../reconcile/background-reconciler.ts'
import type { ClockService } from '../ports/clock-service.ts'
import type { ActivityPort } from '../ports/activity-port.ts'
import type { ProgressPort } from '../ports/progress-port.ts'
import { isSilentStop, type ReconcileStop } from '../reconcile/reconcile.ts'
import type { BacklinkTargetService } from '../capture/backlink-target-service.ts'
import { errorMessage, isAppError, toAppError } from '../errors.ts'
import type { AssetStoreService } from '../graph/asset-store-service.ts'
import type { NoteFileService } from '../graph/note-file-service.ts'
import { isNoteChangedError, patchNote } from '../graph/patch-note.ts'
import { AUDIO_MEMOS_DIR, dailyPath } from '../graph/paths.ts'
import type { FileChangeService } from '../indexing/file-change-service.ts'
import type { Unlisten } from '../unlisten.ts'
import { wikiLinkSafe } from '../markdown/edit.ts'
import { appendListItem } from '../markdown/task-ast.ts'
import type { TranscriptionEngine } from '../settings/schema.ts'
import type { SettingsService } from '../settings/settings-service.ts'

/**
 * The category note every audio-memo section backlinks; recordings that
 * aren't meetings join the same section.
 */
export const AUDIO_MEMOS_NOTE_TITLE = 'Audio memos'

/**
 * One reconcile pass of {@link AudioMemoTranscriptionService}.
 */
export interface ReconcileAudioMemosInput {
  /**
   * `GraphInfo.generation`, pins every write to the issuing graph.
   */
  generation: number
  /**
   * Whether a best-effort text-model pass formats each fresh transcript.
   */
  formatTranscript: boolean
  /**
   * User transcription hint, sent with every segment.
   */
  transcriptionPrompt: string
  /**
   * Which engine transcribes: the configured cloud provider, or on-device.
   */
  engine: TranscriptionEngine
  /**
   * The on-device model, used when `engine` is `local`.
   */
  localModel: LocalTranscriptionModelId
  /**
   * Spoken languages as ISO 639 codes; empty detects any.
   */
  transcriptionLanguages: readonly string[]
  /**
   * Abort gate, checked between memos (graph switch / unmount).
   */
  isStale?: () => boolean
  /**
   * Observes how many memos need transcription, before work starts.
   */
  onPending?: (count: number) => void
}

export interface ReconcileAudioMemosOutcome {
  /**
   * Memos that had no transcription when the pass started.
   */
  pending: number
  /**
   * Memos this pass transcribed and backlinked.
   */
  transcribed: number
  /**
   * Memos whose recording the provider refused — tombstoned with a failure note.
   */
  rejected: number
  /**
   * Why memos remain pending, or `null` when the pass drained.
   */
  stopped: ReconcileStop | null
}

export interface AudioMemoTranscriptionServiceDeps {
  readonly noteFile: NoteFileService
  readonly assetStore: AssetStoreService
  readonly backlinkTarget: BacklinkTargetService
  readonly transcription: TranscriptionService
  readonly localTranscription: LocalTranscriptionService
  readonly transcriptEnrichment: TranscriptEnrichmentService
  readonly aiProviderConfig: AiProviderConfigService
  readonly aiCredentials: AiCredentialService
  readonly settings: SettingsService
  readonly reconcilers: BackgroundReconcilerFactory
  readonly activity: ActivityPort
  readonly fileChanges: FileChangeService
  readonly progress: ProgressPort
  readonly clock: ClockService
}

/**
 * The background-transcription lifecycle for one graph session. Built on
 * `BackgroundReconcilerFactory` (shared with capture and asset
 * descriptions): the single-flight loop, focus/online retries, and teardown live
 * there; this adds the transcription pass, the config gate (no IO without a
 * usable engine), and the `transcribing` flag the mic spinner reads.
 */
export interface AudioMemoTranscriptionSession {
  /**
   * Attach the triggers (focus, online, visible, file changes) and run the launch pass.
   */
  start(): void
  /**
   * Request a pass; coalesces while one runs (at most one follow-up).
   */
  schedule(): void
  /**
   * True while a pass has memos to transcribe, drives the mic spinner.
   */
  getTranscribing(): boolean
  /**
   * Subscribe to `transcribing` changes.
   */
  subscribe(listener: () => void): Unlisten
  /**
   * Tear down triggers and abort an in-flight pass at its next gate.
   */
  dispose(): void
}

export interface AudioMemoTranscriptionSessionOptions {
  /**
   * The open graph's generation. Every pass's reads and writes pin to it.
   */
  generation: number
}

/**
 * The transcription half of the audio-memo pipeline, which is raw-first like
 * the capture-inbox spool: the recording itself is the durable artifact, and
 * transcription is async enrichment that can fail and retry freely.
 *
 * A memo's transcription is a note with the **same basename**
 * (`notes/<base>.md`). Any memo without one resolves or creates the
 * `Audio memos` category note, is transcribed — by the configured BYOK
 * provider, or on this device by the chosen local model — optionally
 * formatted and named in one best-effort small-model pass (cloud engine
 * only: on-device transcripts never reach a text model), written to its
 * transcription note, and backlinked from its day's daily note — transcript
 * note first, because it carries the result: a failure between the two
 * writes leaves an unlinked note, never a tombstoned memo whose transcript
 * was dropped. A failed pass (offline, bad key) leaves the memo pending; the
 * next trigger retries. Nothing is ever lost to a network error. A recording
 * the provider *refuses* (oversized, unsupported container) is tombstoned
 * with a failure note instead — retrying the same bytes can't help, and
 * stopping would wedge every memo behind it.
 *
 * Deleting a transcription note does **not** resurrect it: the daily-note
 * backlink doubles as the tombstone (a memo is only pending while *neither*
 * its note nor its backlink exists). Deleting both regenerates the
 * transcription on the next pass — the documented way to redo one. The
 * backlink targets the memo's *base name*, declared as a frontmatter alias
 * on the transcription note: bases are unique per recording, so two memos
 * stopped within the same second (whose display titles collide) can never
 * tombstone each other, and the link survives a note-title rename.
 *
 * Privacy: the captured audio and its fresh transcript (for naming and optional
 * formatting) are sent to user-configured providers — never any existing note
 * content; the on-device engine sends nothing anywhere. All output is written
 * locally, so recording is allowed even when the daily note is `private: true`.
 */
export interface AudioMemoTranscriptionService {
  /**
   * Transcribe every pending session and assemble the finished ones. Segments
   * without a cached transcript are transcribed and cached one by one — so a
   * session still being recorded transcribes as it grows, and a pass that dies
   * at segment 7 of 24 never re-bills the first six. Every closed, gap-free
   * session then becomes one transcription note plus its daily-note backlink.
   * The note is written **first** — it carries the result, so a failure
   * between the two writes leaves an unlinked note (recoverable from All
   * Notes), never a backlink-tombstoned session whose transcript was dropped.
   * The note is only ever created, never written over: when another device's
   * transcript claimed the path first, the session gets neither a note nor a
   * backlink from this pass and counts as neither transcribed nor rejected.
   * A segment the provider refuses is cached as a terminal failure and
   * surfaces as one line in the assembled note — one bad container never
   * sinks the meeting. A session the graph refuses to read (a local-only
   * folder linked in as `audio-memos/`) is skipped without a note, cache
   * entry, or backlink. Any other failure stops the pass — one session's
   * network or auth error means the rest would fail the same way. Never
   * throws.
   *
   * A transcription service that answers a whole-session transcript for the
   * key (the App Review demo) skips all of that: the session gets that
   * transcript under its timestamp title, with no segment read, no provider
   * call, and no cache write.
   */
  reconcile(input: ReconcileAudioMemosInput): Promise<ReconcileAudioMemosOutcome>
  /**
   * Build the lifecycle for one graph session. `dispose()` is terminal.
   */
  openSession(options: AudioMemoTranscriptionSessionOptions): AudioMemoTranscriptionSession
}

/**
 * Matches the plain and aliased form of the memo's backlink. The probe is the
 * memo's base, never its display title — titles have second precision and a
 * sibling memo from the same second must not read as this memo's tombstone.
 */
function hasBacklink(source: string, memo: AudioMemoIdentity): boolean {
  return source.includes(`[[${memo.base}`)
}

/**
 * The note declares its base name as an alias so the daily-note link
 * (`[[<base>|…]]`) resolves through the index — and keeps resolving if the
 * user renames the title. The links to the original recording close the note,
 * after the transcript they came from.
 */
function transcriptionNote(
  memo: AudioMemoIdentity,
  title: string,
  body: string,
  recordings: string,
): string {
  return `---\naliases: [${memo.base}]\n---\n\n# ${title}\n\n${body}\n\n${recordings}\n`
}

/**
 * The note's link line: every segment stays reachable from the transcript.
 */
function recordingLinks(session: AudioMemoSession): string {
  return session.parts
    .map((part, index) =>
      index === 0 ? `[Recording](${part.path})` : `[Part ${index + 1}](${part.path})`,
    )
    .join(' · ')
}

interface TranscribeSessionPartsInput {
  session: AudioMemoSession
  transcriber: SegmentTranscriber
  generation: number
  /**
   * Abort gate, consulted before and after every slow await.
   */
  isStale: () => boolean
}

type TranscribeSessionPartsOutcome =
  /**
   * Every segment has a terminal result, in part order.
   */
  | { status: 'done'; results: AudioMemoPartResult[] }
  /**
   * A segment's bytes aren't locally readable yet; assembly must wait.
   */
  | { status: 'partial' }
  | { status: 'stale' }
  /**
   * A segment tripped the size guard — skip the session, never tombstone.
   */
  | { status: 'oversize' }
  /**
   * The graph refused to read a segment (`traversal`: a local-only folder
   * linked in as `audio-memos/`, or a path leaving the graph) — skip the
   * session for good, recording nothing about it.
   */
  | { status: 'refused' }

/**
 * The engine a reconcile pass transcribes with.
 */
interface ResolvedTranscriptionEngine {
  transcriber: SegmentTranscriber
  /**
   * The text model that titles (and optionally formats) each transcript.
   */
  enrichmentCredentials: AudioMemoEnrichmentCredentials | null
  /**
   * The cloud key, for the whole-session transcript a demo key answers; `null`
   * for the on-device engine.
   */
  apiKey: string | null
}

interface AudioMemoTranscriptionSessionDeps {
  readonly aiProviderConfig: AiProviderConfigService
  readonly settings: SettingsService
  readonly reconcilers: BackgroundReconcilerFactory
  readonly activity: ActivityPort
  readonly fileChanges: FileChangeService
  readonly progress: ProgressPort
  readonly reconcile: (input: ReconcileAudioMemosInput) => Promise<ReconcileAudioMemosOutcome>
}

class AudioMemoTranscriptionSessionImpl implements AudioMemoTranscriptionSession {
  readonly #deps: AudioMemoTranscriptionSessionDeps
  readonly #generation: number
  #transcribing = false
  readonly #listeners = new Set<() => void>()
  /**
   * Last surfaced stop message. Focus/online retries must not re-toast it.
   */
  #surfacedStop: string | null = null
  readonly #loop: ReturnType<BackgroundReconcilerFactory['create']>

  constructor(
    deps: AudioMemoTranscriptionSessionDeps,
    options: AudioMemoTranscriptionSessionOptions,
  ) {
    this.#deps = deps
    this.#generation = options.generation
    this.#loop = deps.reconcilers.create({
      pass: (isStale) => this.#pass(isStale),
      onSettled: () => {
        this.#setTranscribing(false)
      },
    })
  }

  start(): void {
    const { activity, fileChanges } = this.#deps
    const loop = this.#loop
    if (loop.isStale()) {
      return
    }
    loop.schedule() // the launch pass: memos left pending by earlier sessions
    loop.retryOnWake() // the network's natural retry signals (focus/online)
    loop.onDispose(() => {
      this.#listeners.clear()
    })
    // Foregrounding on iOS doesn't reliably fire `focus`/`online` on the
    // webview, becoming visible does. A memo captured (or its
    // transcription failed offline) while backgrounded gets its retry when
    // the app comes back.
    loop.onDispose(
      activity.subscribeVisible(() => {
        loop.schedule()
      }),
    )
    loop.onDispose(
      fileChanges.subscribe(({ changes }) => {
        const hasNewRecording = changes.some(
          (change) => change.kind === 'upsert' && audioMemoFromPath(change.path) !== null,
        )
        if (hasNewRecording) {
          loop.schedule()
        }
      }),
    )
  }

  schedule(): void {
    this.#loop.schedule()
  }

  getTranscribing(): boolean {
    return this.#transcribing
  }

  subscribe(listener: () => void): Unlisten {
    const entry = (): void => {
      listener()
    }
    this.#listeners.add(entry)
    return () => {
      this.#listeners.delete(entry)
    }
  }

  dispose(): void {
    this.#loop.dispose()
  }

  #setTranscribing(next: boolean): void {
    if (this.#transcribing === next) {
      return
    }
    this.#transcribing = next
    for (const listener of this.#listeners) {
      listener()
    }
  }

  #surfaceStop(stopped: ReconcileStop | null): void {
    if (stopped === null) {
      this.#surfacedStop = null
      return
    }
    // Expected, self-healing stops (network/config/stale) stay silent: offline
    // retries on the next trigger, and a missing provider/key already disables
    // the mic with the reason as its tooltip.
    if (isSilentStop(stopped) || this.#surfacedStop === stopped.message) {
      return
    }
    this.#surfacedStop = stopped.message
    this.#deps.progress.fail('Transcribing audio memo', stopped.message)
  }

  /**
   * One pass: transcribe pending memos, gated behind a usable engine.
   */
  async #pass(isStale: () => boolean): Promise<void> {
    const { aiProviderConfig, settings, reconcile } = this.#deps
    // The settings are read at the start of every pass rather than captured
    // once: a toggle, a hint edit, or an engine, model or language change
    // applies to the very next pass.
    const current = settings.get()
    // Gate before any IO: without a transcription-capable cloud model every
    // pass would list the graph just to stop on `config`. The on-device
    // engine's model check is itself one cheap IPC, made inside the pass.
    if (
      current.transcriptionEngine === 'cloud' &&
      aiProviderConfig.transcriptionConfig() === null
    ) {
      return
    }
    const outcome = await reconcile({
      generation: this.#generation,
      formatTranscript: current.transcriptionFormat,
      transcriptionPrompt: current.transcriptionPrompt,
      engine: current.transcriptionEngine,
      localModel: current.localTranscriptionModel,
      transcriptionLanguages: current.transcriptionLanguages,
      isStale,
      onPending: (count) => {
        this.#setTranscribing(count > 0)
      },
    })
    this.#surfaceStop(outcome.stopped)
  }
}

class AudioMemoTranscriptionServiceImpl implements AudioMemoTranscriptionService {
  readonly #deps: AudioMemoTranscriptionServiceDeps

  constructor(deps: AudioMemoTranscriptionServiceDeps) {
    this.#deps = deps
  }

  async reconcile(input: ReconcileAudioMemosInput): Promise<ReconcileAudioMemosOutcome> {
    const { backlinkTarget, transcription, transcriptEnrichment, clock } = this.#deps
    let sessions: AudioMemoSession[]
    try {
      sessions = await this.#listPendingSessions(input.generation)
    } catch (cause) {
      return {
        pending: 0,
        transcribed: 0,
        rejected: 0,
        stopped: { reason: toAppError(cause).kind, message: errorMessage(cause) },
      }
    }
    input.onPending?.(sessions.length)
    if (sessions.length === 0) {
      return { pending: 0, transcribed: 0, rejected: 0, stopped: null }
    }

    // The gate is consulted again after every slow await (the asset read, the
    // provider call), not just per session: a graph switch mid-transcription
    // must not bill another provider call or touch any note. Reads and writes
    // are additionally generation-pinned in Rust, so even the unguardable gap
    // between a gate check and the IPC call cannot cross graphs.
    const stale = (): boolean => input.isStale?.() === true
    const engine = await this.#resolveTranscriptionEngine(input, stale)
    if ('stopped' in engine) {
      return { pending: sessions.length, transcribed: 0, rejected: 0, stopped: engine.stopped }
    }
    const { transcriber, enrichmentCredentials, apiKey } = engine

    let transcribed = 0
    let rejected = 0
    let sawOversize = false
    let memosNoteTitle: string | null = null
    const stalled = (): ReconcileAudioMemosOutcome => ({
      pending: sessions.length,
      transcribed,
      rejected,
      stopped: { reason: 'stale', message: 'the graph session ended mid-pass' },
    })
    const nowMs = clock.now()
    for (const session of sessions) {
      if (stale()) {
        return stalled()
      }
      const memo = session.memo
      try {
        const sessionTranscript = apiKey === null ? null : transcription.sessionTranscript(apiKey)
        if (sessionTranscript !== null) {
          // A whole-session transcript (the App Review demo) — no provider
          // calls, no per-segment cache.
          if (!isSessionReady(session, nowMs)) {
            continue
          }
          memosNoteTitle ??= await backlinkTarget.ensure(AUDIO_MEMOS_NOTE_TITLE, input.generation)
          if (stale()) return stalled()
          const note = transcriptionNote(
            memo,
            memo.title,
            sessionTranscript,
            recordingLinks(session),
          )
          if (!(await this.#createTranscriptionNote(memo, note, input.generation))) {
            continue
          }
          await this.#ensureDailyBacklink(memo, memo.title, memosNoteTitle, input.generation)
          transcribed += 1
          continue
        }
        const parts = await this.#transcribeSessionParts({
          session,
          transcriber,
          generation: input.generation,
          isStale: stale,
        })
        if (parts.status === 'stale') {
          return stalled()
        }
        if (parts.status === 'oversize') {
          sawOversize = true
          continue
        }
        if (parts.status === 'refused') {
          continue
        }
        if (parts.status === 'partial' || !isSessionReady(session, nowMs)) {
          // Still recording, or a segment isn't locally readable yet — its
          // finished segments are cached; assembly waits for a later pass.
          continue
        }
        memosNoteTitle ??= await backlinkTarget.ensure(AUDIO_MEMOS_NOTE_TITLE, input.generation)
        if (stale()) return stalled()
        const anyRejected = parts.results.some((result) => 'rejected' in result)
        const allRejected = parts.results.every((result) => 'rejected' in result)
        const stitched = stitchSessionTranscript(parts.results)
        let title = memo.title
        let body = stitched
        if (!anyRejected) {
          if (stitched === '') {
            body = 'No speech detected.'
          } else {
            const enriched = await transcriptEnrichment.enrich({
              transcript: stitched,
              enrichmentCredentials,
              formatTranscript: input.formatTranscript,
              fallbackTitle: memo.title,
            })
            title = enriched.title
            body = enriched.body
          }
        }
        if (stale()) {
          return stalled()
        }
        const note = transcriptionNote(memo, title, body, recordingLinks(session))
        if (!(await this.#createTranscriptionNote(memo, note, input.generation))) {
          continue
        }
        await this.#ensureDailyBacklink(memo, title, memosNoteTitle, input.generation)
        if (allRejected) {
          rejected += 1
        } else {
          transcribed += 1
        }
      } catch (cause) {
        // A graph switch mid-flight surfaces as whatever the in-flight call
        // threw (usually `network`, from the gated send), but the truth is
        // the session ended. Classify by the gate, not the symptom.
        if (stale()) {
          return stalled()
        }
        return {
          pending: sessions.length,
          transcribed,
          rejected,
          stopped: { reason: toAppError(cause).kind, message: errorMessage(cause) },
        }
      }
    }
    return {
      pending: sessions.length,
      transcribed,
      rejected,
      stopped: sawOversize
        ? {
            reason: 'oversize',
            message:
              'A recording segment is larger than the transcription size guard allows; it stays pending.',
          }
        : null,
    }
  }

  openSession(options: AudioMemoTranscriptionSessionOptions): AudioMemoTranscriptionSession {
    const { aiProviderConfig, settings, reconcilers, activity, fileChanges, progress } = this.#deps
    return new AudioMemoTranscriptionSessionImpl(
      {
        aiProviderConfig,
        settings,
        reconcilers,
        activity,
        fileChanges,
        progress,
        reconcile: (input) => this.reconcile(input),
      },
      options,
    )
  }

  /**
   * Resolve the pass's engine. Re-resolved on every pass (not once at record
   * time): a pass after the user fixes their configuration must see the fix.
   * The on-device engine needs its model downloaded and makes no network call
   * at all: its transcripts are never sent to a text model, so they keep their
   * raw body and a title taken from their own first words. The cloud engine
   * needs a provider entry with a key, and its configured text model titles
   * (and optionally formats) each transcript. Keys are read at most once per
   * entry per pass.
   */
  async #resolveTranscriptionEngine(
    input: ReconcileAudioMemosInput,
    isStale: () => boolean,
  ): Promise<ResolvedTranscriptionEngine | { stopped: ReconcileStop }> {
    const { assetStore, transcription, localTranscription, aiProviderConfig, aiCredentials } =
      this.#deps
    if (input.engine === 'local') {
      const status = await localTranscription.status(input.localModel).catch(() => null)
      if (status?.status !== 'ready') {
        return {
          stopped: {
            reason: 'config',
            message: 'The on-device transcription model is not downloaded.',
          },
        }
      }
      return {
        transcriber: localSegmentTranscriber(localTranscription, {
          model: input.localModel,
          prompt: input.transcriptionPrompt,
          languages: input.transcriptionLanguages,
          generation: input.generation,
        }),
        enrichmentCredentials: null,
        apiKey: null,
      }
    }

    const target = await aiProviderConfig.resolveTranscriptionTarget(
      aiCredentials.createPassReader(),
    )
    if (target === 'no-provider') {
      return { stopped: { reason: 'config', message: 'No OpenAI or Gemini model is configured.' } }
    }
    if (target === 'no-key') {
      const preferred = aiProviderConfig.transcriptionConfig()
      return {
        stopped: {
          reason: 'config',
          message: `The API key for the configured ${preferred?.provider ?? 'transcription'} model is missing from the keychain.`,
        },
      }
    }
    const { config, apiKey } = target
    const enrichmentConfig = aiProviderConfig.smallModelConfig()
    const enrichmentApiKey =
      enrichmentConfig === null
        ? null
        : enrichmentConfig.id === config.id
          ? apiKey
          : await aiCredentials.read(enrichmentConfig).catch(() => null)
    const fallbackEnrichmentConfig = smallModelConfig(config)
    return {
      transcriber: cloudSegmentTranscriber(
        { assetStore, transcription },
        {
          provider: config.provider,
          apiKey,
          prompt: input.transcriptionPrompt,
          languages: input.transcriptionLanguages,
          generation: input.generation,
          isStale,
        },
      ),
      enrichmentCredentials:
        enrichmentConfig !== null && enrichmentApiKey !== null
          ? { config: enrichmentConfig, apiKey: enrichmentApiKey }
          : fallbackEnrichmentConfig !== null
            ? { config: fallbackEnrichmentConfig, apiKey }
            : null,
      apiKey,
    }
  }

  /**
   * Claim the memo's transcription note path with the no-clobber create; false
   * when a file already owns it. Whether a memo is pending is decided at the
   * start of the pass, so another device can transcribe the same recording
   * while this one waits on a provider: its note is left byte-for-byte intact,
   * and its backlink is already in the daily note or arrives with its push.
   */
  async #createTranscriptionNote(
    memo: AudioMemoIdentity,
    note: string,
    generation: number,
  ): Promise<boolean> {
    const outcome = await this.#deps.noteFile.create(memo.notePath, note, generation)
    return outcome.kind === 'created'
  }

  /**
   * The day's note source at `generation`, where "no note yet" reads as empty.
   */
  async #dailyNoteSource(date: string, generation: number): Promise<string> {
    const { noteFile } = this.#deps
    try {
      return await noteFile.read(dailyPath(date), generation)
    } catch (cause) {
      if (isAppError(cause) && cause.kind === 'notFound') {
        return ''
      }
      throw cause
    }
  }

  /**
   * Sessions awaiting transcription, oldest first: recordings under
   * `audio-memos/` grouped by session base, with no same-named transcription
   * note and no daily-note backlink (the backlink is the tombstone — see the
   * service doc). Every read is pinned to `generation` — recordings, notes, and
   * daily-note tombstones must come from one graph session, never a mix across
   * a switch.
   */
  async #listPendingSessions(generation: number): Promise<AudioMemoSession[]> {
    const { noteFile } = this.#deps
    const [recordings, notes] = await Promise.all([
      noteFile.listDir(AUDIO_MEMOS_DIR, generation),
      noteFile.listNotes(generation),
    ])
    const existingNotes = new Set(notes.map((file) => file.path))
    const parts = recordings
      .map((file): AudioMemoPart | null => {
        const parsed = audioMemoPartFromPath(file.path)
        if (parsed === null) {
          return null
        }
        return {
          memo: parsed.memo,
          path: file.path,
          part: parsed.part,
          end: parsed.end,
          placeholder: file.placeholder === true,
          sizeBytes: file.size,
          modifiedMs: file.modifiedMs,
        }
      })
      .filter((part): part is AudioMemoPart => part !== null)
    const sessions = groupAudioMemoSessions(parts).filter(
      (session) => !existingNotes.has(session.memo.notePath),
    )
    const pending: AudioMemoSession[] = []
    for (const session of sessions) {
      if (!hasBacklink(await this.#dailyNoteSource(session.memo.date, generation), session.memo)) {
        pending.push(session)
      }
    }
    return pending
  }

  /**
   * Append the memo's wikilink once under `## [[Audio memos]]`, creating the
   * heading and daily file as needed. The watcher reindexes the direct write;
   * open dirty editors park a conflict instead of being clobbered.
   *
   * The write is checked against the daily note it read (absent included). When
   * the daily changes in between, it is re-read: a backlink that arrived in the
   * meantime ends the step, otherwise the entry is appended once more. Losing
   * that race too skips the backlink — the transcript note already holds the
   * result, and an unlinked note is the pipeline's recoverable failure mode.
   */
  async #ensureDailyBacklink(
    memo: AudioMemoIdentity,
    title: string,
    memosNoteTitle: string,
    generation: number,
  ): Promise<void> {
    const { noteFile } = this.#deps
    const displayTitle = wikiLinkSafe(title) || memo.title
    const entry = `[[${memo.base}|${displayTitle}]]`
    try {
      await patchNote(
        noteFile,
        dailyPath(memo.date),
        (source) =>
          source !== null && hasBacklink(source, memo)
            ? null
            : appendListItem(source ?? '', {
                kind: 'bullet',
                markdown: entry,
                section: { titles: [memosNoteTitle, AUDIO_MEMOS_NOTE_TITLE], linked: true },
              }),
        generation,
        { attempts: 2 },
      )
    } catch (cause) {
      if (!isNoteChangedError(cause)) {
        throw cause
      }
    }
  }

  /**
   * Read a segment's cached result, or `null` when none is stored yet.
   */
  async #readPartTranscript(
    part: AudioMemoPart,
    generation: number,
  ): Promise<AudioMemoPartResult | null> {
    const { assetStore } = this.#deps
    let raw: string
    try {
      raw = await assetStore.readTranscriptCache(partTranscriptName(part), generation)
    } catch (cause) {
      if (isAppError(cause) && cause.kind === 'notFound') {
        return null
      }
      throw cause
    }
    return decodePartResult(raw)
  }

  async #writePartTranscript(
    part: AudioMemoPart,
    result: AudioMemoPartResult,
    generation: number,
  ): Promise<void> {
    const { assetStore } = this.#deps
    await assetStore.writeTranscriptCache(
      partTranscriptName(part),
      encodePartResult(result),
      generation,
    )
  }

  /**
   * Transcribe every uncached segment of one session, caching each result as
   * it lands. Cached segments cost nothing, so retries after a mid-session
   * failure only pay for what is still missing — and a session that is still
   * recording gets its finished segments transcribed while it grows. Throws on
   * unexpected provider errors (network, auth); the caller classifies them.
   */
  async #transcribeSessionParts(
    input: TranscribeSessionPartsInput,
  ): Promise<TranscribeSessionPartsOutcome> {
    const results: AudioMemoPartResult[] = []
    for (const part of input.session.parts) {
      if (input.isStale()) {
        return { status: 'stale' }
      }
      const cached = await this.#readPartTranscript(part, input.generation)
      if (cached !== null) {
        results.push(cached)
        continue
      }
      if (part.placeholder) {
        return { status: 'partial' }
      }
      if (part.sizeBytes > input.transcriber.maxSegmentBytes) {
        return { status: 'oversize' }
      }
      if (part.sizeBytes === 0) {
        // A stop can flush an empty final segment purely as the end marker —
        // there is nothing to send a provider.
        await this.#writePartTranscript(part, { text: '' }, input.generation)
        results.push({ text: '' })
        continue
      }
      let result: AudioMemoPartResult
      try {
        const transcript = await input.transcriber.transcribe(part)
        result =
          transcript.segments === undefined
            ? { text: transcript.text }
            : { text: transcript.text, segments: transcript.segments }
      } catch (cause) {
        if (isTranscriptionOversize(cause)) {
          return { status: 'oversize' }
        }
        if (isAppError(cause) && cause.kind === 'traversal') {
          return { status: 'refused' }
        }
        if (!isTranscriptionRejected(cause)) {
          throw cause
        }
        // Terminal for these bytes: cache the refusal so it is one failure
        // line in the note, not a retry loop.
        result = { rejected: errorMessage(cause) }
      }
      if (input.isStale()) {
        return { status: 'stale' }
      }
      await this.#writePartTranscript(part, result, input.generation)
      results.push(result)
    }
    return { status: 'done', results }
  }
}

export function createAudioMemoTranscriptionService(
  deps: AudioMemoTranscriptionServiceDeps,
): AudioMemoTranscriptionService {
  return new AudioMemoTranscriptionServiceImpl(deps)
}
