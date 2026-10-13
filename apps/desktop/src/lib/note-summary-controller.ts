import {
  hasBridge,
  isNotePath,
  isSilentStop,
  reconcileNoteSummaries,
  sameSummariesModel,
  subscribeIndexApplied,
  type AiProvidersState,
  type AiSummariesModel,
  type AiSummaryMode,
  type NoteSummaryConsent,
  type ReconcileStop,
} from '@reflect/core'
import { openSession } from '@/editor/open-documents.ts'
import { createBackgroundReconciler } from '@/lib/background-reconciler.ts'
import { providerFetch } from '@/lib/provider-fetch.ts'

/**
 * The AI note-summary lifecycle for one graph session, on
 * {@link createBackgroundReconciler}. A pass runs at launch (the backfill),
 * after every indexed note change, on focus/online, and when the quiet period
 * of a note held back for recent edits runs out. Each pass summarizes a
 * bounded batch and queues a follow-up while more remain.
 *
 * Notes the pass could not summarize at their indexed revision are remembered
 * for the session, so a refusal is never re-sent until the note changes. A
 * missing model (`config`) holds the loop off for {@link CONFIG_BACKOFF_MS}
 * unless the providers, the mode or the chosen models change, so saves don't
 * re-probe a local server that isn't running. A cloud pass the user hasn't
 * agreed to yet asks through `onConsentNeeded`, once per controller and model.
 */
export interface NoteSummaryController {
  /** Attach the triggers and run the launch pass. */
  start(): void
  /**
   * A setting the passes read changed (mode, model, providers): run a pass
   * now, asking again if a go-ahead is still needed. A change may have
   * withdrawn the open ask.
   */
  refresh(): void
  /** Tear down triggers and timers; abort an in-flight pass at its next gate. */
  dispose(): void
}

/** The model each summary mode uses; `null` picks one (see `ReconcileNoteSummariesInput`). */
export interface NoteSummaryModels {
  local: AiSummariesModel | null
  cloud: AiSummariesModel | null
}

export interface NoteSummaryControllerOptions {
  /** The open graph's generation — every pass's reads and writes pin to it. */
  generation: number
  /** The configured-providers state, read at the start of every pass. */
  getProviders: () => AiProvidersState
  /** The `aiSummaries` setting, read at the start of every pass. */
  getMode: () => AiSummaryMode
  /** The model each mode uses (`aiSummariesLocalModel`, `aiSummariesCloudModel`), read per pass. */
  getModels: () => NoteSummaryModels
  /** `aiSummariesCloudConsent` when the controller was built; a change rebuilds it. */
  cloudConsent: AiSummariesModel | null
  /** A cloud pass is waiting for the user's go-ahead; called once per controller and model. */
  onConsentNeeded: (consent: NoteSummaryConsent) => void
  /**
   * Brings other devices' changes in before a pass's first model call (the
   * backup's pull), so a note another device already summarized is skipped.
   */
  catchUp: () => Promise<void>
}

/** How long a `config` stop (no usable model) holds the loop off. */
const CONFIG_BACKOFF_MS = 10 * 60_000

/** Floor for the quiet-period timer, so a due-now note can't spin it. */
const MIN_TIMER_MS = 1_000

/** Build the controller for one graph session. `dispose()` is terminal. */
export function createNoteSummaryController(
  options: NoteSummaryControllerOptions,
): NoteSummaryController {
  let started = false
  const settled = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | null = null
  /** A `config` stop: the snapshot it held for, and until when. */
  let blocked: { snapshot: string; until: number } | null = null
  let loggedStop: string | null = null
  /** The model the open ask names; a pass naming another asks again. */
  let askedChoice: AiSummariesModel | null = null

  function snapshot(): string {
    return JSON.stringify([options.getMode(), options.getProviders(), options.getModels()])
  }

  function surfaceStop(stopped: ReconcileStop | null): void {
    if (stopped === null) {
      loggedStop = null
      return
    }
    if (isSilentStop(stopped) || loggedStop === stopped.message) {
      return
    }
    loggedStop = stopped.message
    console.warn(`note summaries stopped (${stopped.reason}): ${stopped.message}`)
  }

  function scheduleAt(dueAt: number): void {
    if (timer !== null) {
      clearTimeout(timer)
    }
    timer = setTimeout(
      () => {
        timer = null
        loop.schedule()
      },
      Math.max(MIN_TIMER_MS, dueAt - Date.now()),
    )
  }

  const reconcile = async (isStale: () => boolean): Promise<void | 'stop'> => {
    const mode = options.getMode()
    if (!hasBridge() || mode === 'off') {
      return
    }
    const passSnapshot = snapshot()
    if (blocked !== null && blocked.snapshot === passSnapshot && Date.now() < blocked.until) {
      return
    }
    blocked = null
    const passIsStale = (): boolean => isStale() || snapshot() !== passSnapshot
    const models = options.getModels()
    const outcome = await reconcileNoteSummaries({
      providers: options.getProviders(),
      mode,
      localModel: models.local,
      cloudModel: models.cloud,
      cloudConsent: options.cloudConsent,
      generation: options.generation,
      fetchFn: providerFetch,
      isStale: passIsStale,
      isBusy: (path) => openSession(path, options.generation)?.isDirty() === true,
      settled,
      catchUp: options.catchUp,
    })
    for (const key of outcome.settled) settled.add(key)
    surfaceStop(outcome.stopped)
    const consent = outcome.consent
    if (consent !== null && !sameSummariesModel(consent.choice, askedChoice) && !isStale()) {
      askedChoice = consent.choice
      options.onConsentNeeded(consent)
    }
    if (outcome.nextDueAt !== null && !isStale()) {
      scheduleAt(outcome.nextDueAt)
    }
    if (outcome.stopped?.reason === 'config') {
      blocked = { snapshot: passSnapshot, until: Date.now() + CONFIG_BACKOFF_MS }
      return 'stop'
    }
    if (outcome.stopped !== null) {
      return 'stop' // transient: the next trigger retries
    }
    if (outcome.remaining) {
      loop.schedule()
    }
  }

  const loop = createBackgroundReconciler({ pass: reconcile })
  loop.onDispose(() => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  })

  function start(): void {
    if (started || loop.isStale()) {
      return
    }
    started = true
    loop.retryOnWake()
    if (!hasBridge()) {
      return
    }
    // The post-apply signal, so a pass reads a settled index: the note's
    // privacy flag and body length are already projected when it runs.
    loop.onDispose(
      subscribeIndexApplied((changes, generation) => {
        if (generation !== options.generation) {
          return
        }
        if (changes.some((change) => change.kind === 'upsert' && isNotePath(change.path))) {
          loop.schedule()
        }
      }),
    )
    loop.schedule()
  }

  function refresh(): void {
    askedChoice = null
    if (started && !loop.isStale()) {
      loop.schedule()
    }
  }

  return { start, refresh, dispose: loop.dispose }
}
