import type { RenderResult } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { WritableStore, type AudioMemoSessionState } from '@reflect/core'
import { AudioMemoContext } from '@/providers/audio-memo-provider.tsx'
import { AudioMemoButton } from './audio-memo-button.tsx'

const IDLE: AudioMemoSessionState = {
  phase: 'idle',
  stream: null,
  nativeRecorder: false,
  available: true,
  unavailableReason: null,
  error: null,
  canRetry: false,
  pendingCount: 0,
  recorderState: 'idle',
}

const state = new WritableStore(IDLE)
const elapsedMs = new WritableStore(0)
const actions = { toggle: vi.fn(), cancel: vi.fn(), retry: vi.fn(), discard: vi.fn() }
const session = { get: state.get, subscribe: state.subscribe, elapsedMs }

function setMemo(patch: Partial<AudioMemoSessionState>): void {
  state.set({ ...state.get(), ...patch })
}

function renderButton(): Promise<RenderResult> {
  return renderInApp(
    <AudioMemoContext value={{ session, ...actions, subscribeLevel: null }}>
      <AudioMemoButton />
    </AudioMemoContext>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  state.set(IDLE)
  elapsedMs.set(0)
})

describe('AudioMemoButton', () => {
  it('unavailable renders aria-disabled — never natively disabled — and ignores clicks', async () => {
    setMemo({
      available: false,
      unavailableReason: 'Add an OpenAI or Gemini model in Settings to record audio memos',
    })
    const view = await renderButton()

    // aria-disabled (not `disabled`) keeps pointer events alive so the
    // explanatory tooltip can fire; the reason copy itself is asserted in the
    // provider test.
    const micButton = view.getByRole('button', { name: 'Record audio memo' })
    await expect.element(micButton).toHaveAttribute('aria-disabled', 'true')
    expect(micButton.element()).toHaveProperty('disabled', false)

    // force: playwright refuses to click aria-disabled controls on its own.
    await userEvent.click(micButton, { force: true })
    expect(actions.toggle).not.toHaveBeenCalled()
  })

  it('recording turns the mic into the stop control', async () => {
    setMemo({ phase: 'recording' })
    const view = await renderButton()

    await userEvent.click(view.getByRole('button', { name: 'Stop recording' }))
    expect(actions.toggle).toHaveBeenCalled()
  })

  it('escape cancels a recording without transcribing', async () => {
    setMemo({ phase: 'recording' })
    const view = await renderButton()

    view.getByRole('button', { name: 'Stop recording' }).element().focus()
    await userEvent.keyboard('{Escape}')
    expect(actions.cancel).toHaveBeenCalled()
    expect(actions.toggle).not.toHaveBeenCalled()
  })

  it('escape is inert while transcribing — stopping committed the save', async () => {
    setMemo({ phase: 'transcribing' })
    await renderButton()

    await userEvent.keyboard('{Escape}')
    expect(actions.cancel).not.toHaveBeenCalled()
    expect(actions.discard).not.toHaveBeenCalled()
  })

  it('the mic stays live while earlier memos transcribe', async () => {
    setMemo({ phase: 'transcribing' })
    const view = await renderButton()

    await userEvent.click(view.getByRole('button', { name: 'Record audio memo' }))
    expect(actions.toggle).toHaveBeenCalled()
  })
})
