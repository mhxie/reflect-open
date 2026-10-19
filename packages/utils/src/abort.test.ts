import { getEventListeners } from 'node:events'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { timeoutSignal } from './index.ts'

function aborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => {
      resolve()
    })
  })
}

describe('timeoutSignal', () => {
  it('aborts with a TimeoutError after the delay', async () => {
    const signal = timeoutSignal(5)
    expect(signal.aborted).toBe(false)
    await aborted(signal)
    expect(signal.reason).toBeInstanceOf(DOMException)
    expect((signal.reason as DOMException).name).toBe('TimeoutError')
  })

  it('times out without aborting the caller, and lets go of its signal', async () => {
    const caller = new AbortController()
    const signal = timeoutSignal(5, caller.signal)
    expect(getEventListeners(caller.signal, 'abort')).toHaveLength(1)
    await aborted(signal)
    expect((signal.reason as DOMException).name).toBe('TimeoutError')
    expect(caller.signal.aborted).toBe(false)
    expect(getEventListeners(caller.signal, 'abort')).toHaveLength(0)
  })

  it('aborts as soon as the caller aborts, with the caller’s reason, and stops its timer', () => {
    const setTimer = vi.spyOn(globalThis, 'setTimeout')
    const clearTimer = vi.spyOn(globalThis, 'clearTimeout')
    onTestFinished(() => {
      vi.restoreAllMocks()
    })
    const caller = new AbortController()
    const signal = timeoutSignal(60_000, caller.signal)
    const reason = new Error('closed')
    caller.abort(reason)
    expect(signal.aborted).toBe(true)
    expect(signal.reason).toBe(reason)
    expect(setTimer).toHaveBeenCalledTimes(1)
    expect(clearTimer).toHaveBeenCalledWith(setTimer.mock.results[0]?.value)
  })

  it('starts aborted when the caller already aborted', () => {
    const reason = new Error('gone')
    const signal = timeoutSignal(60_000, AbortSignal.abort(reason))
    expect(signal.aborted).toBe(true)
    expect(signal.reason).toBe(reason)
  })
})
