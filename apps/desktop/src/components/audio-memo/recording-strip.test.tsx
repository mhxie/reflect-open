import { render, type RenderResult } from 'vitest-browser-react'
import { page, userEvent } from 'vitest/browser'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@/test-utils/locator.ts'

const memo = vi.hoisted(() => ({
  phase: 'idle' as 'idle' | 'requesting' | 'recording' | 'transcribing' | 'error',
  elapsedMs: 0,
  stream: null,
  subscribeLevel: null,
  error: null as string | null,
  canRetry: false,
  cancel: vi.fn(),
  retry: vi.fn(),
  discard: vi.fn(),
}))
const recorder = vi.hoisted(() => ({
  lastTranscript: null as string | null,
  dismissTranscript: vi.fn(),
}))
const openNote = vi.hoisted(() => vi.fn())

vi.mock('@/providers/audio-memo-provider.tsx', () => ({ useAudioMemo: () => ({ ...memo }) }))
vi.mock('@/providers/recorder-provider.tsx', () => ({
  useOptionalRecorder: () => ({ ...recorder }),
}))
vi.mock('@/components/peek/peek-provider.tsx', () => ({ usePeekNavigation: () => openNote }))
vi.mock('@/hooks/use-note-row.ts', () => ({
  useNoteRow: () => ({ title: 'Call with Sarah Chen' }),
}))

const { RecordingStrip } = await import('./recording-strip.tsx')

function renderStrip(): Promise<RenderResult> {
  return render(<RecordingStrip />)
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
    expect(openNote).toHaveBeenCalledWith({
      target: { kind: 'note', path: 'recordings/2026-10-03-call.md' },
      openInNewWindow: false,
    })
    expect(recorder.dismissTranscript).toHaveBeenCalled()
  })
})
