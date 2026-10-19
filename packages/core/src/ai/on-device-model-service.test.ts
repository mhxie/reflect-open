import { describe, expect, it } from 'vitest'
import { cloudTarget, modelTarget } from '../privacy/on-device.ts'
import { createTestOnDeviceHttpService, type TestOnDeviceRequest } from '../testing/ai.ts'
import { createOnDeviceModelService } from './on-device-model-service.ts'

const BASE_URL = 'http://localhost:11434/v1'

const ATTESTED = modelTarget({
  id: 'ollama',
  provider: 'openai-compatible',
  model: 'gemma4:26b',
  baseUrl: BASE_URL,
  keyHint: '',
  onDevice: { baseUrl: BASE_URL, model: 'gemma4:26b', server: 'ollama' },
})

const LOCAL_SHOW = { modelfile: 'FROM /models/gemma.gguf', details: {}, model_info: {} }

/** A fake Ollama on this Mac answering `/api/version`, `/api/show` and `/api/tags`. */
function ollama(show: object = LOCAL_SHOW, tags: object[] = []) {
  return createTestOnDeviceHttpService((request: TestOnDeviceRequest) => {
    const json = request.url.endsWith('/api/version')
      ? { version: '0.35.1' }
      : request.url.endsWith('/api/tags')
        ? { models: tags }
        : show
    return { headers: [['content-type', 'application/json']], chunks: [JSON.stringify(json)] }
  })
}

describe('OnDeviceModelService', () => {
  it('passes a cloud target through without reaching this Mac', async () => {
    const server = ollama()
    const models = createOnDeviceModelService({ onDeviceHttp: server })
    const cloud = cloudTarget({ id: 'openai', provider: 'openai', model: 'gpt-5.5', keyHint: '' })

    await expect(models.verify(cloud, 'sk-test')).resolves.toBe(cloud)
    expect(server.requests()).toEqual([])
  })

  it('verifies an attested model through the loopback transport, with its key', async () => {
    const server = ollama()
    const models = createOnDeviceModelService({ onDeviceHttp: server })

    const verified = await models.verify(ATTESTED, 'local-key')

    expect(verified).toBe(ATTESTED)
    expect(server.requests().map(({ method, url }) => `${method} ${url}`)).toEqual([
      'GET http://localhost:11434/api/version',
      'POST http://localhost:11434/api/show',
    ])
    expect(server.requests()[0]!.headers).toContainEqual(['authorization', 'Bearer local-key'])
    expect(server.openRequests()).toEqual([])
  })

  it('refuses a model Ollama routes off this Mac, never falling back to cloud', async () => {
    const models = createOnDeviceModelService({
      onDeviceHttp: ollama({ ...LOCAL_SHOW, remote_host: 'https://ollama.com' }),
    })

    await expect(models.verify(ATTESTED, '')).rejects.toMatchObject({ kind: 'auth' })
  })

  it('lists the installed models through the same transport', async () => {
    const server = ollama({ capabilities: ['completion'] }, [
      { name: 'gemma4:26b', details: { parameter_size: '26B' } },
      { name: 'kimi-k3:cloud' },
    ])
    const models = createOnDeviceModelService({ onDeviceHttp: server })

    await expect(models.listOllamaModels()).resolves.toEqual({
      kind: 'ok',
      models: [{ name: 'gemma4:26b', parameterSize: '26B' }],
    })
    expect(server.requests()[0]?.url).toBe('http://localhost:11434/api/tags')
  })
})
