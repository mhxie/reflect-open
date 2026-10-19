import { APICallError, type LanguageModel } from '@reflect/modules/ai'
import { MockLanguageModelV4 } from '@reflect/modules/ai/test'
import type { LanguageModelV4CallOptions, LanguageModelV4Usage } from '@ai-sdk/provider'
import { describe, expect, it } from 'vitest'
import { NO_LOCAL_ONLY_FOLDERS } from '../graph/local-only.ts'
import { cloudSafeNoteContent } from '../privacy/privacy-service.ts'
import {
  cloudTarget,
  modelTarget,
  type ModelTarget,
  type VerifiedOnDeviceTarget,
} from '../privacy/on-device.ts'
import type { HostedAiProviderConfig, OnDeviceServerKind } from '../settings/schema.ts'
import { createTestLanguageModelService, createTestOnDeviceModelService } from '../testing/ai.ts'
import type { TargetModel } from './language-model-service.ts'
import { normalizedNoteSummary, summarizeNote } from './summarize-note.ts'

const USAGE: LanguageModelV4Usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
}

const CONFIG: HostedAiProviderConfig = {
  id: 'cfg-anthropic',
  provider: 'anthropic',
  model: 'claude-haiku-4-5',
  keyHint: 'wxyz1',
}

const CLOUD = cloudTarget(CONFIG)

async function localTarget(server: OnDeviceServerKind): Promise<VerifiedOnDeviceTarget> {
  const baseUrl = 'http://localhost:11434/v1'
  const target = await createTestOnDeviceModelService().verify(
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

/** `model` bound to `target`, as the language model service binds it. */
async function bound<TTarget extends ModelTarget>(
  target: TTarget,
  model: LanguageModel,
): Promise<TargetModel<TTarget>> {
  return await createTestLanguageModelService(model).createFor(target, '')
}

function note(content: string): ReturnType<typeof cloudSafeNoteContent> {
  return cloudSafeNoteContent(NO_LOCAL_ONLY_FOLDERS, {
    path: 'notes/plan.md',
    isPrivate: false,
    title: 'Plan',
    content,
    truncated: false,
  })
}

function answering(text: string, calls: LanguageModelV4CallOptions[] = []): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: (options) => {
      calls.push(options)
      return Promise.resolve({
        content: [{ type: 'text', text }],
        finishReason: { unified: 'stop' as const, raw: undefined },
        usage: USAGE,
        warnings: [],
      })
    },
  })
}

function throwing(error: unknown): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: () =>
      Promise.try(() => {
        throw error
      }),
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
    const model = await bound(CLOUD, answering('Plans the beta launch.', calls))
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
      model: await bound(await localTarget('ollama'), answering('Plans it.', ollama)),
      note: source,
    })
    await summarizeNote({
      model: await bound(
        await localTarget('openai-compatible'),
        answering('Plans it.', otherServer),
      ),
      note: source,
    })
    await summarizeNote({
      model: await bound(CLOUD, answering('Plans it.', cloud)),
      note: note('Ship it in May.'),
    })

    expect(ollama[0]?.reasoning).toBe('none')
    expect(otherServer[0]?.reasoning).toBeUndefined()
    expect(cloud[0]?.reasoning).toBeUndefined()
  })

  it('resolves null when the provider refuses the note', async () => {
    const model = await bound(CLOUD, throwing(apiError(400)))
    await expect(summarizeNote({ model, note: note('x') })).resolves.toBeNull()
  })

  it('throws retryable errors for credentials and outages', async () => {
    await expect(
      summarizeNote({ model: await bound(CLOUD, throwing(apiError(401))), note: note('x') }),
    ).rejects.toMatchObject({ kind: 'auth' })
    await expect(
      summarizeNote({ model: await bound(CLOUD, throwing(apiError(503))), note: note('x') }),
    ).rejects.toMatchObject({ kind: 'network' })
  })
})
