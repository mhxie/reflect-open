import { APICallError } from '@reflect/modules/ai'
import { MockLanguageModelV3 } from '@reflect/modules/ai/test'
import type { LanguageModelV3CallOptions, LanguageModelV3Usage } from '@ai-sdk/provider'
import { describe, expect, it } from 'vitest'
import { cloudSafeNoteContent } from '../privacy/checkers.ts'
import { modelTarget } from '../privacy/on-device.ts'
import type { AiProviderConfig } from '../settings/schema.ts'
import { testTargetModel } from '../testing/target-model.ts'
import { normalizedNoteSummary, summarizeNote } from './summarize-note.ts'

const USAGE: LanguageModelV3Usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
}

const CONFIG: AiProviderConfig = {
  id: 'cfg-anthropic',
  provider: 'anthropic',
  model: 'claude-haiku-4-5',
  keyHint: 'wxyz1',
}

const CLOUD = modelTarget({ ...CONFIG, provider: 'anthropic' })

function note(content: string): ReturnType<typeof cloudSafeNoteContent> {
  return cloudSafeNoteContent({
    path: 'notes/plan.md',
    isPrivate: false,
    title: 'Plan',
    content,
    truncated: false,
  })
}

function answering(text: string, calls: LanguageModelV3CallOptions[] = []): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async (options) => {
      calls.push(options)
      return {
        content: [{ type: 'text', text }],
        finishReason: { unified: 'stop' as const, raw: undefined },
        usage: USAGE,
        warnings: [],
      }
    },
  })
}

function throwing(error: unknown): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => {
      throw error
    },
  })
}

function apiError(statusCode: number): APICallError {
  return new APICallError({
    message: `status ${statusCode}`,
    url: 'https://api.example.test',
    requestBodyValues: {},
    statusCode,
  })
}

describe('normalizedNoteSummary', () => {
  it('keeps the first line, unwrapped and unformatted', () => {
    expect(normalizedNoteSummary('\n"**Plans** the beta launch."\nExtra')).toBe(
      'Plans the beta launch.',
    )
    expect(normalizedNoteSummary('Summary: Plans   the beta.')).toBe('Plans the beta.')
  })

  it('cuts long answers at a word boundary and rejects empty ones', () => {
    const summary = normalizedNoteSummary('word '.repeat(100))
    expect(summary!.length).toBeLessThanOrEqual(200)
    expect(summary!.endsWith('word')).toBe(true)
    expect(normalizedNoteSummary('  \n ""')).toBeNull()
  })
})

describe('summarizeNote', () => {
  it('sends the title and body and returns the normalized answer', async () => {
    const calls: LanguageModelV3CallOptions[] = []
    const model = testTargetModel(CLOUD, answering('Plans the beta launch.', calls))
    await expect(summarizeNote({ model, note: note('Ship it in May.') })).resolves.toBe(
      'Plans the beta launch.',
    )
    const prompt = JSON.stringify(calls[0]?.prompt)
    expect(prompt).toContain('Title: Plan')
    expect(prompt).toContain('Ship it in May.')
  })

  it('resolves null when the provider refuses the note', async () => {
    const model = testTargetModel(CLOUD, throwing(apiError(400)))
    await expect(summarizeNote({ model, note: note('x') })).resolves.toBeNull()
  })

  it('throws retryable errors for credentials and outages', async () => {
    await expect(
      summarizeNote({ model: testTargetModel(CLOUD, throwing(apiError(401))), note: note('x') }),
    ).rejects.toMatchObject({ kind: 'auth' })
    await expect(
      summarizeNote({ model: testTargetModel(CLOUD, throwing(apiError(503))), note: note('x') }),
    ).rejects.toMatchObject({ kind: 'network' })
  })
})
