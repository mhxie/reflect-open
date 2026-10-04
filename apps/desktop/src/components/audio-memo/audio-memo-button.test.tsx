import { render, type RenderResult } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip.tsx'

const memo = vi.hoisted(() => ({
  phase: 'idle' as 'idle' | 'requesting' | 'recording' | 'transcribing' | 'error',
  elapsedMs: 0,
  stream: null,
  subscribeLevel: null,
  available: true,
  unavailableReason: null as string | null,
  error: null as string | null,
  canRetry: false,
  toggle: vi.fn(),
  cancel: vi.fn(),
  retry: vi.fn(),
  discard: vi.fn(),
}))

vi.mock('@/providers/audio-memo-provider.tsx', () => ({
  useAudioMemo: () => ({ ...memo }),
}))

const { AudioMemoButton } = await import('./audio-memo-button.tsx')

function renderButton(): Promise<RenderResult> {
  return render(
    <TooltipProvider>
      <AudioMemoButton />
    </TooltipProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  memo.phase = 'idle'
  memo.elapsedMs = 0
  memo.available = true
  memo.unavailableReason = null
  memo.error = null
  memo.canRetry = false
})

describe('AudioMemoButton', () => {
  it('unavailable renders aria-disabled — never natively disabled — and ignores clicks', async () => {
    memo.available = false
    memo.unavailableReason = 'Add an OpenAI or Gemini model in Settings to record audio memos'
    const view = await renderButton()

    // aria-disabled (not `disabled`) keeps pointer events alive so the
    // explanatory tooltip can fire; the reason copy itself is asserted in the
    // provider test.
    const micButton = view.getByRole('button', { name: 'Record audio memo' })
    await expect.element(micButton).toHaveAttribute('aria-disabled', 'true')
    expect(micButton.element()).toHaveProperty('disabled', false)

    // force: playwright refuses to click aria-disabled controls on its own.
    await userEvent.click(micButton, { force: true })
    expect(memo.toggle).not.toHaveBeenCalled()
  })

  it('recording turns the mic into the stop control', async () => {
    memo.phase = 'recording'
    const view = await renderButton()

    await userEvent.click(view.getByRole('button', { name: 'Stop recording' }))
    expect(memo.toggle).toHaveBeenCalled()
  })

  it('escape cancels a recording without transcribing', async () => {
    memo.phase = 'recording'
    const view = await renderButton()

    view.getByRole('button', { name: 'Stop recording' }).element().focus()
    await userEvent.keyboard('{Escape}')
    expect(memo.cancel).toHaveBeenCalled()
    expect(memo.toggle).not.toHaveBeenCalled()
  })

  it('escape is inert while transcribing — stopping committed the save', async () => {
    memo.phase = 'transcribing'
    await renderButton()

    await userEvent.keyboard('{Escape}')
    expect(memo.cancel).not.toHaveBeenCalled()
    expect(memo.discard).not.toHaveBeenCalled()
  })

  it('the mic stays live while earlier memos transcribe', async () => {
    memo.phase = 'transcribing'
    const view = await renderButton()

    await userEvent.click(view.getByRole('button', { name: 'Record audio memo' }))
    expect(memo.toggle).toHaveBeenCalled()
  })
})
