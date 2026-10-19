import { describe, expect, it, vi, type Mock } from 'vitest'
import { createTestOperationsService, type TestOperationsService } from '@reflect/app/testing'
import type { AiSummariesModel } from '@reflect/core'
import {
  createNoteSummaryOffer,
  type NoteSummaryDestination,
  type NoteSummaryOffer,
} from './note-summary-offer.ts'

const NANO: NoteSummaryDestination = {
  provider: 'openai',
  choice: { configId: 'work', modelId: 'gpt-5.4-nano' },
}

function setup(): { operations: TestOperationsService; summaries: NoteSummaryOffer } {
  const operations = createTestOperationsService()
  return { operations, summaries: createNoteSummaryOffer(operations) }
}

function handlers(destination: NoteSummaryDestination | null): {
  destination: () => NoteSummaryDestination | null
  start: Mock<(choice: AiSummariesModel) => void>
} {
  return { destination: () => destination, start: vi.fn<(choice: AiSummariesModel) => void>() }
}

async function pressStart(operations: TestOperationsService): Promise<void> {
  const [offer, ...rest] = operations.getAll()
  expect(rest).toEqual([])
  await offer!.action!.run()
}

describe('createNoteSummaryOffer', () => {
  it('names the waiting notes, provider and model; Start pins that model once', async () => {
    const { operations, summaries } = setup()
    const answer = handlers(NANO)
    summaries.offer({ notes: 12, ...NANO }, answer)
    // A later pass re-raising the ask replaces it rather than stacking a second.
    summaries.offer({ notes: 12, ...NANO }, answer)

    expect(operations.getAll()).toEqual([
      expect.objectContaining({
        label: 'Summarize 12 notes with OpenAI (gpt-5.4-nano)?',
        persistent: true,
      }),
    ])
    await pressStart(operations)
    expect(answer.start).toHaveBeenCalledExactlyOnceWith(NANO.choice)
    expect(operations.getAll()).toEqual([])
  })

  it('asks again instead of agreeing when the model changed meanwhile', async () => {
    const { operations, summaries } = setup()
    let destination: NoteSummaryDestination | null = {
      provider: 'anthropic',
      choice: { configId: 'personal', modelId: 'claude-haiku-4-5' },
    }
    const start = vi.fn<(choice: AiSummariesModel) => void>()
    summaries.offer({ notes: 1, ...NANO }, { destination: () => destination, start })

    await pressStart(operations)
    expect(start).not.toHaveBeenCalled()
    expect(operations.getAll()[0]?.label).toBe(
      'Summarize 1 note with Anthropic (claude-haiku-4-5)?',
    )

    // Another model on the same entry is another destination too.
    destination = {
      provider: 'anthropic',
      choice: { configId: 'personal', modelId: 'claude-opus-4-8' },
    }
    await pressStart(operations)
    expect(start).not.toHaveBeenCalled()
    expect(operations.getAll()[0]?.label).toBe('Summarize 1 note with Anthropic (claude-opus-4-8)?')

    destination = null
    await pressStart(operations)
    expect(start).not.toHaveBeenCalled()
    expect(operations.getAll()).toEqual([])
  })

  it('takes back an ask that no longer applies', () => {
    const { operations, summaries } = setup()
    summaries.offer({ notes: 1, ...NANO }, handlers(NANO))
    summaries.withdraw()
    expect(operations.getAll()).toEqual([])
  })
})
