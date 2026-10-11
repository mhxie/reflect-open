import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { AiProviderId } from '@reflect/core'
import { getOperations, resetOperations } from '@/lib/operations.ts'
import { offerNoteSummaries, withdrawNoteSummariesOffer } from './note-summary-offer.ts'

afterEach(() => {
  withdrawNoteSummariesOffer()
  resetOperations()
})

function handlers(provider: AiProviderId | null): {
  provider: () => AiProviderId | null
  start: Mock<() => void>
} {
  return { provider: () => provider, start: vi.fn<() => void>() }
}

async function pressStart(): Promise<void> {
  const [offer, ...rest] = getOperations()
  expect(rest).toEqual([])
  await offer!.action!.run()
}

describe('offerNoteSummaries', () => {
  it('names the waiting notes and the provider; Start records the go-ahead once', async () => {
    const answer = handlers('openai')
    offerNoteSummaries({ notes: 12, provider: 'openai' }, answer)
    // A later pass re-raising the ask replaces it rather than stacking a second.
    offerNoteSummaries({ notes: 12, provider: 'openai' }, answer)

    expect(getOperations()).toEqual([
      expect.objectContaining({ label: 'Summarize 12 notes with OpenAI?', persistent: true }),
    ])
    await pressStart()
    expect(answer.start).toHaveBeenCalledTimes(1)
    expect(getOperations()).toEqual([])
  })

  it('asks again instead of agreeing when the default provider changed meanwhile', async () => {
    let provider: AiProviderId | null = 'anthropic'
    const start = vi.fn<() => void>()
    offerNoteSummaries({ notes: 1, provider: 'openai' }, { provider: () => provider, start })

    await pressStart()
    expect(start).not.toHaveBeenCalled()
    expect(getOperations()[0]?.label).toBe('Summarize 1 note with Anthropic?')

    provider = null
    await pressStart()
    expect(start).not.toHaveBeenCalled()
    expect(getOperations()).toEqual([])
  })

  it('takes back an ask that no longer applies', () => {
    offerNoteSummaries({ notes: 1, provider: 'anthropic' }, handlers('anthropic'))
    withdrawNoteSummariesOffer()
    expect(getOperations()).toEqual([])
  })
})
