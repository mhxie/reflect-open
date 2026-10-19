import { describe, expect, it } from 'vitest'
import { createTestHttpService, type TestHttpReply } from '../testing/http.ts'
import { resolveOnDeviceTarget } from './on-device.ts'
import { verifyOnDeviceServer } from './on-device-verification.ts'
import type { OnDeviceServerKind } from '../settings/schema.ts'

const VERSION_URL = 'http://127.0.0.1:11434/api/version'
const SHOW_URL = 'http://127.0.0.1:11434/api/show'

function target(model = 'local:latest', server: OnDeviceServerKind = 'ollama') {
  const baseUrl = 'http://127.0.0.1:11434/v1'
  const resolved = resolveOnDeviceTarget({
    id: 'local',
    provider: 'openai-compatible',
    model,
    baseUrl,
    keyHint: '',
    onDevice: { model, baseUrl, server },
  })
  if (resolved === null) throw new Error('Expected a valid local target')
  return resolved
}

const LOCAL_SHOW = { modelfile: 'FROM /models/local.gguf', details: {}, model_info: {} }

/** An Ollama server answering its version, then `show` with `show`. */
function ollama(show: TestHttpReply = { status: 200, json: LOCAL_SHOW }) {
  return createTestHttpService([
    { method: 'GET', url: VERSION_URL, reply: { status: 200, json: { version: '0.35.1' } } },
    { method: 'POST', url: SHOW_URL, reply: show },
  ])
}

describe('local model verification', () => {
  it('checks the exact installed Ollama model before accepting private access', async () => {
    const http = ollama()
    expect(await verifyOnDeviceServer(http, target())).toBe('ok')
    expect(http.requests().map((request) => request.url)).toEqual([VERSION_URL, SHOW_URL])
    expect(JSON.parse(http.requests()[1]?.body ?? '')).toEqual({
      model: 'local:latest',
      verbose: false,
    })
  })

  it('sends the key it is given as a bearer token', async () => {
    const http = ollama()
    expect(await verifyOnDeviceServer(http, target(), { apiKey: 'local-key' })).toBe('ok')
    expect(http.requests().map((request) => request.headers.get('authorization'))).toEqual([
      'Bearer local-key',
      'Bearer local-key',
    ])
  })

  it.each(['model:cloud', 'model:large-cloud', 'model: CLOUD ', 'registry/model:large-CLOUD'])(
    'rejects cloud reference %s before any request',
    async (model) => {
      const http = ollama()
      expect(await verifyOnDeviceServer(http, target(model))).toMatchObject({ kind: 'refused' })
      expect(http.requests()).toEqual([])
    },
  )

  it.each([{ remote_host: 'https://ollama.com' }, { remote_model: 'model:cloud' }])(
    'rejects remote metadata hidden by a local alias: %j',
    async (remote) => {
      const http = ollama({ status: 200, json: { ...LOCAL_SHOW, ...remote } })
      expect(await verifyOnDeviceServer(http, target('alias:latest'))).toMatchObject({
        kind: 'refused',
      })
    },
  )

  it('accepts a bare -cloud name only after checking local metadata', async () => {
    const http = ollama()
    expect(await verifyOnDeviceServer(http, target('local-cloud'))).toBe('ok')
    expect(http.requests()).toHaveLength(2)
  })

  it.each([{}, { details: {}, model_info: {} }, { modelfile: 'FROM local', details: {} }])(
    'fails closed on incomplete show data: %j',
    async (body) => {
      const http = ollama({ status: 200, json: body })
      expect(await verifyOnDeviceServer(http, target())).toMatchObject({ kind: 'refused' })
    },
  )

  it('does not turn a failed Ollama check into a generic server success', async () => {
    const http = createTestHttpService([{ method: '*', url: () => true, reply: { status: 503 } }])
    expect(await verifyOnDeviceServer(http, target('local', 'openai-compatible'))).toMatchObject({
      kind: 'refused',
    })
  })

  it('requires explicit generic server attestation when its native API is absent', async () => {
    // An unrouted request answers 404, as a server without Ollama's API does.
    const http = createTestHttpService()
    expect(await verifyOnDeviceServer(http, target())).toMatchObject({ kind: 'refused' })
    expect(await verifyOnDeviceServer(http, target('local', 'openai-compatible'))).toBe('ok')
  })

  it('bounds untrusted model metadata', async () => {
    const http = ollama({ status: 200, json: { ...LOCAL_SHOW, modelfile: 'x'.repeat(1_048_577) } })
    expect(await verifyOnDeviceServer(http, target())).toMatchObject({ kind: 'refused' })
  })

  it('fails closed when the server cannot be reached', async () => {
    const http = createTestHttpService([
      {
        method: '*',
        url: () => true,
        reply: () => {
          throw new TypeError('fetch failed')
        },
      },
    ])
    expect(await verifyOnDeviceServer(http, target())).toMatchObject({ kind: 'refused' })
  })
})
