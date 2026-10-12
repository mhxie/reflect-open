import { APICallError } from '@reflect/modules/ai'
import { MockLanguageModelV4 } from '@reflect/modules/ai/test'
import type { LanguageModelV4CallOptions, LanguageModelV4Usage } from '@ai-sdk/provider'
import { describe, expect, it, vi } from 'vitest'
import { cloudSafeNoteContent } from '../privacy/checkers.ts'
import {
  modelTarget,
  verifyModelTarget,
  type VerifiedOnDeviceTarget,
} from '../privacy/on-device.ts'
import type { AiProviderConfig, OnDeviceServerKind } from '../settings/schema.ts'
import { testTargetModel } from '../testing/target-model.ts'
import { normalizedNoteSummary, summarizeNote } from './summarize-note.ts'

vi.mock('../privacy/on-device-verification', () => ({ verifyOnDeviceServer: async () => 'ok' }))

const USAGE: LanguageModelV4Usage = {
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

async function localTarget(server: OnDeviceServerKind): Promise<VerifiedOnDeviceTarget> {
  const baseUrl = 'http://localhost:11434/v1'
  const target = await verifyModelTarget(
    modelTarget({
      id: 'cfg-local',
      provider: 'openai-compatible',
      model: 'gemma4:26b',
      baseUrl,
      keyHint: '',
      onDevice: { baseUrl, model: 'gemma4:26b', server },
    }),
    '',
  )
  if (target.kind !== 'on-device') {
    throw new Error('expected an on-device target')
  }
  return target
}

function note(content: string): ReturnType<typeof cloudSafeNoteContent> {
  return cloudSafeNoteContent({
    path: 'notes/plan.md',
    isPrivate: false,
    title: 'Plan',
    content,
    truncated: false,
  })
}

function answering(text: string, calls: LanguageModelV4CallOptions[] = []): MockLanguageModelV4 {
  return new MockLanguageModelV4({
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

function throwing(error: unknown): MockLanguageModelV4 {
  return new MockLanguageModelV4({
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
    const calls: LanguageModelV4CallOptions[] = []
    const model = testTargetModel(CLOUD, answering('Plans the beta launch.', calls))
    await expect(summarizeNote({ model, note: note('Ship it in May.') })).resolves.toBe(
      'Plans the beta launch.',
    )
    const prompt = JSON.stringify(calls[0]?.prompt)
    expect(prompt).toContain('Title: Plan')
    expect(prompt).toContain('Ship it in May.')
  })

  it('switches reasoning off for an attested Ollama model only', async () => {
    const source = { title: 'Plan', content: 'Ship it in May.' }
    const ollama: LanguageModelV4CallOptions[] = []
    const otherServer: LanguageModelV4CallOptions[] = []
    const cloud: LanguageModelV4CallOptions[] = []
    await summarizeNote({
      model: testTargetModel(await localTarget('ollama'), answering('Plans it.', ollama)),
      note: source,
    })
    await summarizeNote({
      model: testTargetModel(
        await localTarget('openai-compatible'),
        answering('Plans it.', otherServer),
      ),
      note: source,
    })
    await summarizeNote({
      model: testTargetModel(CLOUD, answering('Plans it.', cloud)),
      note: note('Ship it in May.'),
    })

    expect(ollama[0]?.reasoning).toBe('none')
    expect(otherServer[0]?.reasoning).toBeUndefined()
    expect(cloud[0]?.reasoning).toBeUndefined()
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
