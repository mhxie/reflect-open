import { describe, expect, it } from 'vitest'
import {
  createTestHttpService,
  createTestIdService,
  createTestIpcBridgeService,
  createTestOnDeviceHttpService,
} from '../testing/index.ts'
import { APP_REVIEW_STUB_KEY } from './app-review-demo.ts'
import {
  createAiKeyValidationService,
  type ApiKeyValidation,
  type ApiKeyValidationInput,
} from './ai-key-validation-service.ts'
import { createOnDeviceHttpService, type OnDeviceHttpService } from './on-device-http-service.ts'

/**
 * Validate over `fetchFn` for the cloud; nothing may reach this Mac unless `onDevice` is given.
 */
async function validateApiKey(
  input: ApiKeyValidationInput,
  fetchFn: typeof fetch,
  onDevice: OnDeviceHttpService = createTestOnDeviceHttpService(() => {
    throw new Error('a cloud probe must not reach this Mac')
  }),
): Promise<ApiKeyValidation> {
  return await createAiKeyValidationService({
    http: { fetch: fetchFn },
    onDeviceHttp: onDevice,
  }).validate(input)
}

function fetchReturning(status: number): typeof fetch {
  return async () => new Response(null, { status })
}

const fetchThrowing: typeof fetch = async () => {
  throw new TypeError('network down')
}

describe('AiKeyValidationService', () => {
  it('sends the provider-specific auth headers to the model-listing endpoint', async () => {
    const http = createTestHttpService()

    await validateApiKey({ provider: 'openai', apiKey: 'sk-test' }, http.fetchFn)
    await validateApiKey({ provider: 'anthropic', apiKey: 'sk-ant-test' }, http.fetchFn)
    await validateApiKey({ provider: 'google', apiKey: 'AIza-test' }, http.fetchFn)
    await validateApiKey({ provider: 'openrouter', apiKey: 'sk-or-v1-test' }, http.fetchFn)
    await validateApiKey(
      {
        provider: 'openai-compatible',
        apiKey: 'local-secret',
        baseUrl: 'http://192.168.1.5:1234/v1/',
      },
      http.fetchFn,
    )
    await validateApiKey(
      { provider: 'openai-compatible', apiKey: '', baseUrl: 'http://192.168.1.5:1234/v1' },
      http.fetchFn,
    )

    const calls = http.requests()
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/models')
    expect(calls[0]!.headers.get('Authorization')).toBe('Bearer sk-test')
    expect(calls[1]!.url).toBe('https://api.anthropic.com/v1/models')
    expect(calls[1]!.headers.get('x-api-key')).toBe('sk-ant-test')
    expect(calls[1]!.headers.get('anthropic-version')).toBe('2023-06-01')
    expect(calls[2]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/models')
    expect(calls[2]!.headers.get('x-goog-api-key')).toBe('AIza-test')
    expect(calls[3]!.url).toBe('https://openrouter.ai/api/v1/key')
    expect(calls[3]!.headers.get('Authorization')).toBe('Bearer sk-or-v1-test')
    expect(calls[4]!.url).toBe('http://192.168.1.5:1234/v1/models')
    expect(calls[4]!.headers.get('Authorization')).toBe('Bearer local-secret')
    expect(calls[5]!.url).toBe('http://192.168.1.5:1234/v1/models')
    expect(calls[5]!.headers.get('Authorization')).toBeNull()
  })

  it('reads an ok response as valid', async () => {
    expect(
      await validateApiKey({ provider: 'openai', apiKey: 'sk-test' }, fetchReturning(200)),
    ).toBe('valid')
  })

  it('accepts the App Review demo key without probing the provider', async () => {
    expect(
      await validateApiKey({ provider: 'openai', apiKey: APP_REVIEW_STUB_KEY }, fetchThrowing),
    ).toBe('valid')
  })

  it('reads an auth rejection as invalid', async () => {
    expect(
      await validateApiKey({ provider: 'openai', apiKey: 'sk-test' }, fetchReturning(401)),
    ).toBe('invalid')
    expect(
      await validateApiKey({ provider: 'anthropic', apiKey: 'sk-test' }, fetchReturning(403)),
    ).toBe('invalid')
    // Gemini reports malformed keys as 400.
    expect(await validateApiKey({ provider: 'google', apiKey: 'bad' }, fetchReturning(400))).toBe(
      'invalid',
    )
    expect(
      await validateApiKey(
        { provider: 'openrouter', apiKey: 'sk-or-v1-test' },
        fetchReturning(401),
      ),
    ).toBe('invalid')
    expect(
      await validateApiKey(
        { provider: 'openai-compatible', apiKey: '', baseUrl: 'http://192.168.1.5:1234/v1' },
        fetchReturning(401),
      ),
    ).toBe('invalid')
  })

  it('probes an endpoint on this Mac through the on-device transport', async () => {
    const server = createTestOnDeviceHttpService((request) => ({
      status: request.headers.length === 0 ? 401 : 200,
      chunks: ['{"data":[]}'],
    }))
    const caller = createTestHttpService()

    expect(
      await validateApiKey(
        {
          provider: 'openai-compatible',
          apiKey: 'local-secret',
          baseUrl: 'http://localhost:11434/v1',
        },
        caller.fetchFn,
        server,
      ),
    ).toBe('valid')
    expect(
      await validateApiKey(
        { provider: 'openai-compatible', apiKey: '', baseUrl: 'http://127.0.0.1:1234/v1' },
        caller.fetchFn,
        server,
      ),
    ).toBe('invalid')

    expect(caller.requests()).toEqual([])
    expect(server.requests().map(({ method, url, headers }) => ({ method, url, headers }))).toEqual(
      [
        {
          method: 'GET',
          url: 'http://localhost:11434/v1/models',
          headers: [['authorization', 'Bearer local-secret']],
        },
        { method: 'GET', url: 'http://127.0.0.1:1234/v1/models', headers: [] },
      ],
    )
    // Only the status is read, and no unread body is left holding a slot.
    expect(server.openRequests()).toEqual([])
  })

  it('reads a failed on-device probe as unreachable', async () => {
    const refused = () => {
      throw { kind: 'network', message: 'error sending request: Connection refused (os error 61)' }
    }
    const onDevice = createOnDeviceHttpService({
      ipc: createTestIpcBridgeService({
        commands: {
          on_device_http_send: refused,
          on_device_http_read: refused,
          on_device_http_cancel: () => null,
        },
      }),
      id: createTestIdService(),
    })

    expect(
      await validateApiKey(
        { provider: 'openai-compatible', apiKey: '', baseUrl: 'http://localhost:11434/v1' },
        fetchThrowing,
        onDevice,
      ),
    ).toBe('unreachable')
  })

  it('reads anything that is not an auth decision as unreachable', async () => {
    expect(
      await validateApiKey({ provider: 'openai', apiKey: 'sk-test' }, fetchReturning(500)),
    ).toBe('unreachable')
    expect(
      await validateApiKey({ provider: 'openai', apiKey: 'sk-test' }, fetchReturning(429)),
    ).toBe('unreachable')
    expect(await validateApiKey({ provider: 'openai', apiKey: 'sk-test' }, fetchThrowing)).toBe(
      'unreachable',
    )
  })

  it('reads an invalid OpenAI-compatible base URL as invalid without fetching', async () => {
    const http = createTestHttpService()
    expect(
      await validateApiKey(
        { provider: 'openai-compatible', apiKey: '', baseUrl: 'file:///tmp/model.sock' },
        http.fetchFn,
      ),
    ).toBe('invalid')
    expect(http.requests()).toEqual([])
  })
})
