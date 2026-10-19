import { generateText } from '@reflect/modules/ai'
import { describe, expect, it } from 'vitest'
import { cloudTarget, resolveOnDeviceTarget } from '../privacy/on-device.ts'
import type {
  AiProviderConfig,
  HostedAiProviderConfig,
  OpenAiCompatibleProviderConfig,
} from '../settings/schema.ts'
import { createTestOnDeviceHttpService, type TestOnDeviceHttpService } from '../testing/ai.ts'
import { createTestHttpService } from '../testing/http.ts'
import {
  ANTHROPIC_DIRECT_BROWSER_ACCESS_HEADER,
  ANTHROPIC_DIRECT_BROWSER_ACCESS_VALUE,
} from './anthropic-headers.ts'
import { APP_REVIEW_STUB_KEY, DEMO_REPLY_TEXT } from './app-review-demo.ts'
import { createLanguageModelService, createLazyAiSdkLoader } from './language-model-service.ts'

/**
 * The real service over `fetchFn` for cloud calls and `onDevice` for this Mac.
 */
function service(fetchFn: typeof fetch, onDevice: TestOnDeviceHttpService) {
  return createLanguageModelService({
    http: { fetch: fetchFn },
    onDeviceHttp: onDevice,
    sdk: createLazyAiSdkLoader(),
  })
}

/**
 * The model of the real service over `fetchFn`; nothing may reach this Mac.
 */
async function languageModel(config: AiProviderConfig, apiKey: string, fetchFn: typeof fetch) {
  const onDevice = createTestOnDeviceHttpService(() => {
    throw new Error('a cloud model must not reach this Mac')
  })
  return await service(fetchFn, onDevice).create(config, apiKey)
}

interface RecordedCall {
  readonly url: string
  readonly headers: Headers
  readonly body: string | null
}

const ANTHROPIC_CONFIG: AiProviderConfig = {
  id: 'cfg-anthropic',
  provider: 'anthropic',
  model: 'claude-sonnet-5',
  keyHint: 'wxyz1',
}

const OPENAI_CONFIG: AiProviderConfig = {
  id: 'cfg-openai',
  provider: 'openai',
  model: 'gpt-5.6-terra',
  keyHint: 'wxyz1',
}

const GOOGLE_CONFIG: AiProviderConfig = {
  id: 'cfg-google',
  provider: 'google',
  model: 'gemini-3.5-flash',
  keyHint: 'wxyz1',
}

const OPENROUTER_CONFIG: HostedAiProviderConfig = {
  id: 'cfg-openrouter',
  provider: 'openrouter',
  model: 'openrouter/auto',
  keyHint: 'wxyz1',
}

const OPENAI_COMPATIBLE_CONFIG: AiProviderConfig = {
  id: 'cfg-lan',
  provider: 'openai-compatible',
  model: 'llama-local',
  baseUrl: 'http://192.168.1.5:1234/v1',
  keyHint: '',
}

const ON_DEVICE_CONFIG: OpenAiCompatibleProviderConfig = {
  id: 'cfg-local',
  provider: 'openai-compatible',
  model: 'llama-local',
  baseUrl: 'http://localhost:1234/v1',
  keyHint: '',
}

/** An OpenAI-compatible chat completion answering "ok". */
function chatCompletion(model: string): string {
  return JSON.stringify({
    id: 'chatcmpl_local',
    object: 'chat.completion',
    created: 0,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  })
}

function recordingAnthropicFetch(calls: RecordedCall[]): typeof fetch {
  return async (input, init) => {
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : null,
    })
    return new Response(
      JSON.stringify({
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        model: ANTHROPIC_CONFIG.model,
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }
}

function recordingOpenAiFetch(calls: RecordedCall[]): typeof fetch {
  return async (input, init) => {
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : null,
    })
    return new Response(
      JSON.stringify({
        id: 'resp_123',
        created_at: 0,
        model: OPENAI_CONFIG.model,
        output: [
          {
            type: 'message',
            role: 'assistant',
            id: 'msg_123',
            content: [{ type: 'output_text', text: 'ok', annotations: [] }],
          },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }
}

function recordingOpenRouterFetch(calls: RecordedCall[]): typeof fetch {
  return async (input, init) => {
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : null,
    })
    return new Response(
      JSON.stringify({
        id: 'chatcmpl_123',
        object: 'chat.completion',
        created: 0,
        model: OPENROUTER_CONFIG.model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'ok' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }
}

function recordingOpenAICompatibleFetch(calls: RecordedCall[]): typeof fetch {
  return async (input, init) => {
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : null,
    })
    return new Response(
      JSON.stringify({
        id: 'chatcmpl_local',
        object: 'chat.completion',
        created: 0,
        model: OPENAI_COMPATIBLE_CONFIG.model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'ok' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }
}

describe('LanguageModelService', () => {
  it('routes a GPT-5.6 model through OpenAI Responses', async () => {
    const calls: RecordedCall[] = []

    await generateText({
      model: await languageModel(OPENAI_CONFIG, 'sk-test', recordingOpenAiFetch(calls)),
      prompt: 'hello',
      maxRetries: 0,
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/responses')
    expect(calls[0]!.headers.get('Authorization')).toBe('Bearer sk-test')
    expect(calls[0]!.body).toContain('"model":"gpt-5.6-terra"')
  })

  it('routes Claude Sonnet 5 through Anthropic Messages with direct-browser access', async () => {
    const calls: RecordedCall[] = []

    await generateText({
      model: await languageModel(ANTHROPIC_CONFIG, 'sk-ant-test', recordingAnthropicFetch(calls)),
      prompt: 'hello',
      maxRetries: 0,
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/messages')
    expect(calls[0]!.body).toContain('"model":"claude-sonnet-5"')
    expect(calls[0]!.body).toContain('"max_tokens":128000')
    expect(calls[0]!.headers.get(ANTHROPIC_DIRECT_BROWSER_ACCESS_HEADER)).toBe(
      ANTHROPIC_DIRECT_BROWSER_ACCESS_VALUE,
    )
  })

  it('routes OpenRouter through its OpenAI-compatible chat endpoint', async () => {
    const calls: RecordedCall[] = []

    await generateText({
      model: await languageModel(
        OPENROUTER_CONFIG,
        'sk-or-v1-test',
        recordingOpenRouterFetch(calls),
      ),
      prompt: 'hello',
      maxRetries: 0,
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(calls[0]!.headers.get('Authorization')).toBe('Bearer sk-or-v1-test')
    expect(calls[0]!.headers.get('HTTP-Referer')).toBe('https://reflect.app')
    expect(calls[0]!.headers.get('X-OpenRouter-Title')).toBe('Reflect')
  })

  it('routes custom OpenAI-compatible providers through their configured endpoint', async () => {
    const calls: RecordedCall[] = []

    await generateText({
      model: await languageModel(
        OPENAI_COMPATIBLE_CONFIG,
        '',
        recordingOpenAICompatibleFetch(calls),
      ),
      prompt: 'hello',
      maxRetries: 0,
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('http://192.168.1.5:1234/v1/chat/completions')
    expect(calls[0]!.headers.get('Authorization')).toBeNull()
  })

  it('sends an endpoint on this Mac through the on-device transport, never the caller fetch', async () => {
    const server = createTestOnDeviceHttpService(() => ({
      headers: [['content-type', 'application/json']],
      chunks: [chatCompletion(ON_DEVICE_CONFIG.model)],
    }))
    const caller = createTestHttpService()

    const result = await generateText({
      model: await service(caller.fetchFn, server).create(ON_DEVICE_CONFIG, 'local-key'),
      prompt: 'hello',
      maxRetries: 0,
    })

    expect(result.text).toBe('ok')
    expect(caller.requests()).toEqual([])
    expect(server.requests()).toHaveLength(1)
    expect(server.requests()[0]).toMatchObject({
      method: 'POST',
      url: 'http://localhost:1234/v1/chat/completions',
    })
    expect(server.requests()[0]!.headers).toContainEqual(['authorization', 'Bearer local-key'])
    expect(server.openRequests()).toEqual([])
  })

  it('returns the local demo model for the App Review demo key', async () => {
    const throwingFetch = (() => {
      throw new Error('demo mode must not fetch')
    }) as unknown as typeof fetch

    for (const config of [
      OPENAI_CONFIG,
      ANTHROPIC_CONFIG,
      GOOGLE_CONFIG,
      OPENROUTER_CONFIG,
      OPENAI_COMPATIBLE_CONFIG,
    ]) {
      expect(await languageModel(config, APP_REVIEW_STUB_KEY, throwingFetch)).toMatchObject({
        specificationVersion: 'v3',
        provider: 'reflect-demo',
      })
    }

    const result = await generateText({
      model: await languageModel(OPENAI_CONFIG, APP_REVIEW_STUB_KEY, throwingFetch),
      prompt: 'hello',
      maxRetries: 0,
    })
    expect(result.text).toBe(DEMO_REPLY_TEXT)
  })
})

describe('createFor', () => {
  it('builds an on-device target over the loopback transport, never the cloud fetch', async () => {
    const server = createTestOnDeviceHttpService(() => ({
      headers: [['content-type', 'application/json']],
      chunks: [chatCompletion(ON_DEVICE_CONFIG.model)],
    }))
    const target = resolveOnDeviceTarget({
      ...ON_DEVICE_CONFIG,
      onDevice: { baseUrl: ON_DEVICE_CONFIG.baseUrl, model: ON_DEVICE_CONFIG.model },
    })!
    const cloud = createTestHttpService()

    const bound = await service(cloud.fetchFn, server).createFor(target, '')
    const result = await generateText({ model: bound.model, prompt: 'hello', maxRetries: 0 })

    expect(bound.target).toBe(target)
    expect(Object.isFrozen(bound)).toBe(true)
    expect(result.text).toBe('ok')
    expect(cloud.requests()).toEqual([])
    expect(server.requests().map((request) => request.url)).toEqual([
      'http://localhost:1234/v1/chat/completions',
    ])
  })

  it('builds a cloud target over the cloud fetch', async () => {
    const calls: RecordedCall[] = []
    const target = cloudTarget(OPENROUTER_CONFIG)
    const server = createTestOnDeviceHttpService()

    const bound = await service(recordingOpenRouterFetch(calls), server).createFor(
      target,
      'sk-or-v1-test',
    )
    await generateText({ model: bound.model, prompt: 'hello', maxRetries: 0 })

    expect(bound.target.kind).toBe('cloud')
    expect(calls.map((call) => call.url)).toEqual(['https://openrouter.ai/api/v1/chat/completions'])
    expect(server.requests()).toEqual([])
  })
})

describe('create with the App Review demo key', () => {
  it('answers the demo key with the demo model and never loads a provider SDK', async () => {
    const unexpected = () => Promise.reject(new Error('unexpected SDK load'))
    const languageModels = createLanguageModelService({
      http: { fetch: () => Promise.reject(new Error('unexpected fetch')) },
      onDeviceHttp: { fetch: () => Promise.reject(new Error('unexpected on-device fetch')) },
      sdk: {
        openai: unexpected,
        anthropic: unexpected,
        google: unexpected,
        openaiCompatible: unexpected,
      },
    })

    const model = await languageModels.create(ANTHROPIC_CONFIG, APP_REVIEW_STUB_KEY)

    expect(model).toMatchObject({ specificationVersion: 'v3', provider: 'reflect-demo' })
  })
})
