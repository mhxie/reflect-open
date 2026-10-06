import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AiProvidersState,
  AiSummaryMode,
  FileChange,
  ReconcileNoteSummariesInput,
  ReconcileNoteSummariesOutcome,
} from '@reflect/core'
import {
  createNoteSummaryController,
  type NoteSummaryController,
} from './note-summary-controller.ts'

const reconcileNoteSummaries = vi.hoisted(() =>
  vi.fn<(input: ReconcileNoteSummariesInput) => Promise<ReconcileNoteSummariesOutcome>>(),
)
const subscribeIndexApplied = vi.hoisted(() =>
  vi.fn<(handler: (changes: readonly FileChange[], generation: number) => void) => () => void>(),
)

vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  reconcileNoteSummaries,
  subscribeIndexApplied,
  hasBridge: () => true,
}))
vi.mock('@/lib/provider-fetch.ts', () => ({ providerFetch: vi.fn() }))

const PROVIDERS: AiProvidersState = { providers: [], defaultProviderId: null }
const GEN = 4

function outcome(
  overrides: Partial<ReconcileNoteSummariesOutcome> = {},
): ReconcileNoteSummariesOutcome {
  return {
    pending: 0,
    summarized: 0,
    settled: [],
    remaining: false,
    nextDueAt: null,
    stopped: null,
    ...overrides,
  }
}

let onApplied: ((changes: readonly FileChange[], generation: number) => void) | null = null
let controller: NoteSummaryController | null = null
let mode: AiSummaryMode = 'local'

function create(): NoteSummaryController {
  controller = createNoteSummaryController({
    generation: GEN,
    getProviders: () => PROVIDERS,
    getMode: () => mode,
  })
  return controller
}

async function settle(): Promise<void> {
  for (let tick = 0; tick < 10; tick += 1) {
    await Promise.resolve()
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  reconcileNoteSummaries.mockReset()
  reconcileNoteSummaries.mockResolvedValue(outcome())
  subscribeIndexApplied.mockReset()
  subscribeIndexApplied.mockImplementation((handler) => {
    onApplied = handler
    return () => {
      onApplied = null
    }
  })
  mode = 'local'
})

afterEach(() => {
  controller?.dispose()
  controller = null
  vi.useRealTimers()
})

describe('createNoteSummaryController', () => {
  it('runs a launch pass and a pass after each indexed note change', async () => {
    create().start()
    await settle()
    expect(reconcileNoteSummaries).toHaveBeenCalledTimes(1)
    expect(reconcileNoteSummaries.mock.calls[0]![0]).toMatchObject({ generation: GEN, mode })

    onApplied?.([{ path: 'notes/a.md', kind: 'upsert', modifiedMs: 1 }], GEN)
    await settle()
    expect(reconcileNoteSummaries).toHaveBeenCalledTimes(2)

    onApplied?.([{ path: 'notes/a.md', kind: 'upsert', modifiedMs: 1 }], GEN + 1)
    onApplied?.([{ path: 'assets/a.png', kind: 'upsert', modifiedMs: 1 }], GEN)
    await settle()
    expect(reconcileNoteSummaries).toHaveBeenCalledTimes(2)
  })

  it('passes settled notes back to later passes', async () => {
    reconcileNoteSummaries.mockResolvedValueOnce(outcome({ settled: ['h:notes/a.md'] }))
    create().start()
    await settle()
    onApplied?.([{ path: 'notes/b.md', kind: 'upsert', modifiedMs: 1 }], GEN)
    await settle()
    expect([...(reconcileNoteSummaries.mock.calls[1]![0].settled ?? [])]).toEqual(['h:notes/a.md'])
  })

  it('keeps going while a batch remains and wakes when a quiet period ends', async () => {
    reconcileNoteSummaries
      .mockResolvedValueOnce(outcome({ remaining: true }))
      .mockResolvedValueOnce(outcome({ nextDueAt: Date.now() + 60_000 }))
    create().start()
    await settle()
    expect(reconcileNoteSummaries).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(reconcileNoteSummaries).toHaveBeenCalledTimes(3)
  })

  it('backs off after a missing model until the settings change', async () => {
    reconcileNoteSummaries.mockResolvedValueOnce(
      outcome({ stopped: { reason: 'config', message: 'no model' } }),
    )
    create().start()
    await settle()
    onApplied?.([{ path: 'notes/a.md', kind: 'upsert', modifiedMs: 1 }], GEN)
    await settle()
    expect(reconcileNoteSummaries).toHaveBeenCalledTimes(1)

    mode = 'local-and-cloud'
    onApplied?.([{ path: 'notes/a.md', kind: 'upsert', modifiedMs: 1 }], GEN)
    await settle()
    expect(reconcileNoteSummaries).toHaveBeenCalledTimes(2)
  })

  it('does nothing while summaries are off', async () => {
    mode = 'off'
    create().start()
    await settle()
    expect(reconcileNoteSummaries).not.toHaveBeenCalled()
  })
})
