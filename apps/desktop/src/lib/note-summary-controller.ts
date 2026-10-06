import {
  hasBridge,
  isNotePath,
  isSilentStop,
  reconcileNoteSummaries,
  subscribeIndexApplied,
  type AiProvidersState,
  type AiSummaryMode,
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
 * unless the providers or the mode change, so saves don't re-probe a local
 * server that isn't running.
 */
export interface NoteSummaryController {
  /** Attach the triggers and run the launch pass. */
  start(): void
  /** Tear down triggers and timers; abort an in-flight pass at its next gate. */
  dispose(): void
}

export interface NoteSummaryControllerOptions {
  /** The open graph's generation — every pass's reads and writes pin to it. */
  generation: number
  /** The configured-providers state, read at the start of every pass. */
  getProviders: () => AiProvidersState
  /** The `aiSummaries` setting, read at the start of every pass. */
  getMode: () => AiSummaryMode
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

  function snapshot(): string {
    return JSON.stringify([options.getMode(), options.getProviders()])
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
    const outcome = await reconcileNoteSummaries({
      providers: options.getProviders(),
      mode,
      generation: options.generation,
      fetchFn: providerFetch,
      isStale: passIsStale,
      isBusy: (path) => openSession(path, options.generation)?.isDirty() === true,
      settled,
    })
    for (const key of outcome.settled) settled.add(key)
    surfaceStop(outcome.stopped)
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

  return { start, dispose: loop.dispose }
}
