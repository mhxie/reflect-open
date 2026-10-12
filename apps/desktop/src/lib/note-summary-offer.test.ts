import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { AiSummariesModel } from '@reflect/core'
import { getOperations, resetOperations } from '@/lib/operations.ts'
import {
  offerNoteSummaries,
  withdrawNoteSummariesOffer,
  type NoteSummaryDestination,
} from './note-summary-offer.ts'

afterEach(() => {
  withdrawNoteSummariesOffer()
  resetOperations()
})

const NANO: NoteSummaryDestination = {
  provider: 'openai',
  choice: { configId: 'work', modelId: 'gpt-5.4-nano' },
}

function handlers(destination: NoteSummaryDestination | null): {
  destination: () => NoteSummaryDestination | null
  start: Mock<(choice: AiSummariesModel) => void>
} {
  return { destination: () => destination, start: vi.fn<(choice: AiSummariesModel) => void>() }
}

async function pressStart(): Promise<void> {
  const [offer, ...rest] = getOperations()
  expect(rest).toEqual([])
  await offer!.action!.run()
}

describe('offerNoteSummaries', () => {
  it('names the waiting notes, provider and model; Start pins that model once', async () => {
    const answer = handlers(NANO)
    offerNoteSummaries({ notes: 12, ...NANO }, answer)
    // A later pass re-raising the ask replaces it rather than stacking a second.
    offerNoteSummaries({ notes: 12, ...NANO }, answer)

    expect(getOperations()).toEqual([
      expect.objectContaining({
        label: 'Summarize 12 notes with OpenAI (gpt-5.4-nano)?',
        persistent: true,
      }),
    ])
    await pressStart()
    expect(answer.start).toHaveBeenCalledExactlyOnceWith(NANO.choice)
    expect(getOperations()).toEqual([])
  })

  it('asks again instead of agreeing when the model changed meanwhile', async () => {
    let destination: NoteSummaryDestination | null = {
      provider: 'anthropic',
      choice: { configId: 'personal', modelId: 'claude-haiku-4-5' },
    }
    const start = vi.fn<(choice: AiSummariesModel) => void>()
    offerNoteSummaries({ notes: 1, ...NANO }, { destination: () => destination, start })

    await pressStart()
    expect(start).not.toHaveBeenCalled()
    expect(getOperations()[0]?.label).toBe('Summarize 1 note with Anthropic (claude-haiku-4-5)?')

    // Another model on the same entry is another destination too.
    destination = {
      provider: 'anthropic',
      choice: { configId: 'personal', modelId: 'claude-opus-4-8' },
    }
    await pressStart()
    expect(start).not.toHaveBeenCalled()
    expect(getOperations()[0]?.label).toBe('Summarize 1 note with Anthropic (claude-opus-4-8)?')

    destination = null
    await pressStart()
    expect(start).not.toHaveBeenCalled()
    expect(getOperations()).toEqual([])
  })

  it('takes back an ask that no longer applies', () => {
    offerNoteSummaries({ notes: 1, ...NANO }, handlers(NANO))
    withdrawNoteSummariesOffer()
    expect(getOperations()).toEqual([])
  })
})
