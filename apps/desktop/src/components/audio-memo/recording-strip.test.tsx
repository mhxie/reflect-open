import { createTestCoreServices } from '@reflect/core/testing'
import { page, userEvent } from 'vitest/browser'
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { ReactElement } from 'react'
import { PeekProvider, usePeek } from '@/components/peek/peek-provider.tsx'
import type { AudioMemoContextValue } from '@/providers/audio-memo-provider.tsx'
import '@/test-utils/locator.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import type { Mutable } from '@reflect/utils'

const memo = vi.hoisted((): Mutable<AudioMemoContextValue> => ({
  phase: 'idle',
  elapsedMs: 0,
  stream: null,
  nativeRecorder: false,
  subscribeLevel: null,
  available: true,
  unavailableReason: null,
  error: null,
  canRetry: false,
  toggle: vi.fn(),
  cancel: vi.fn(),
  retry: vi.fn(),
  discard: vi.fn(),
  pendingCount: 0,
  recorderState: 'idle',
}))
const recorder = vi.hoisted(() => ({
  lastTranscript: null as string | null,
  dismissTranscript: vi.fn(),
}))

vi.mock('@/providers/audio-memo-provider.tsx', () => ({ useAudioMemo: () => ({ ...memo }) }))
vi.mock('@/providers/recorder-provider.tsx', () => ({
  useOptionalRecorder: () => ({ ...recorder }),
}))

const { RecordingStrip } = await import('./recording-strip.tsx')

/** What Peek shows, as an attribute so the strip's text stays its own. */
function PeekProbe(): ReactElement {
  const target = usePeek()?.target ?? null
  return <div data-testid="peek" data-target={JSON.stringify(target)} />
}

async function renderStrip() {
  const app = createTestCoreServices({ database: createWasmTestDatabaseService() })
  onTestFinished(() => app.database.close())
  vi.spyOn(app.indexQuery, 'getNote').mockImplementation((path) => {
    return Promise.resolve({
      path,
      title: 'Call with Sarah Chen',
      dailyDate: null,
      isPrivate: false,
      gistUrl: null,
      gistStale: false,
    })
  })
  return await renderInApp(
    <PeekProvider>
      <RecordingStrip />
      <PeekProbe />
    </PeekProvider>,
    { app },
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  memo.phase = 'idle'
  memo.elapsedMs = 0
  memo.error = null
  memo.canRetry = false
  recorder.lastTranscript = null
})

describe('RecordingStrip', () => {
  it('shows nothing while idle with no new transcript', async () => {
    const view = await renderStrip()
    expect(view.container.textContent).toBe('')
  })

  it('shows the elapsed time while recording, and discards', async () => {
    memo.phase = 'recording'
    memo.elapsedMs = 83_000
    await renderStrip()

    const strip = page.getByRole('status', { name: 'Recording' })
    await expect.element(strip.getByText('1:23')).toBeVisible()
    await userEvent.click(strip.getByRole('button', { name: 'Discard recording' }))
    expect(memo.cancel).toHaveBeenCalled()
  })

  it('shows progress while transcribing', async () => {
    memo.phase = 'transcribing'
    await renderStrip()

    await expect.element(page.getByText('Transcribing…')).toBeVisible()
  })

  it('a resumable failure offers Retry and Discard', async () => {
    memo.phase = 'error'
    memo.error = 'provider down'
    memo.canRetry = true
    await renderStrip()

    await expect.element(page.getByText('provider down')).toBeVisible()
    await userEvent.click(page.getByRole('button', { name: 'Retry' }))
    expect(memo.retry).toHaveBeenCalled()
    await userEvent.click(page.getByRole('button', { name: 'Discard', exact: true }))
    expect(memo.discard).toHaveBeenCalled()
  })

  it('a non-resumable failure hides Retry', async () => {
    memo.phase = 'error'
    memo.error = 'came back empty'
    await renderStrip()

    await expect.element(page.getByRole('button', { name: 'Discard', exact: true })).toBeVisible()
    expect(page.getByRole('button', { name: 'Retry' }).query()).toBeNull()
  })

  it('offers the finished transcript, opening it in Peek', async () => {
    recorder.lastTranscript = 'recordings/2026-10-03-call.md'
    await renderStrip()

    const ready = page.getByRole('status', { name: 'Transcript ready' })
    await userEvent.click(ready.getByText('Call with Sarah Chen'))
    await vi.waitFor(() => {
      expect(page.getByTestId('peek').element().getAttribute('data-target')).toContain(
        '"path":"recordings/2026-10-03-call.md"',
      )
    })
    expect(recorder.dismissTranscript).toHaveBeenCalled()
  })
})
