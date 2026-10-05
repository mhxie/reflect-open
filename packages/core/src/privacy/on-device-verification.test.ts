import { describe, expect, it, vi } from 'vitest'
import { resolveOnDeviceTarget } from './on-device.ts'
import { verifyOnDeviceServer } from './on-device-verification.ts'
import type { OnDeviceServerKind } from '../settings/schema.ts'

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

describe('local model verification', () => {
  it('checks the exact installed Ollama model before accepting private access', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ version: '0.35.1' }))
      .mockResolvedValueOnce(Response.json(LOCAL_SHOW))
    expect(await verifyOnDeviceServer(target(), { fetchFn })).toBe('ok')
    expect(fetchFn.mock.calls.map(([url]) => String(url))).toEqual([
      'http://127.0.0.1:11434/api/version',
      'http://127.0.0.1:11434/api/show',
    ])
    expect(JSON.parse(String(fetchFn.mock.calls[1]?.[1]?.body))).toEqual({
      model: 'local:latest',
      verbose: false,
    })
  })

  it.each(['model:cloud', 'model:large-cloud', 'model: CLOUD ', 'registry/model:large-CLOUD'])(
    'rejects cloud reference %s before any request',
    async (model) => {
      const fetchFn = vi.fn<typeof fetch>()
      expect(await verifyOnDeviceServer(target(model), { fetchFn })).toMatchObject({
        kind: 'refused',
      })
      expect(fetchFn).not.toHaveBeenCalled()
    },
  )

  it.each([{ remote_host: 'https://ollama.com' }, { remote_model: 'model:cloud' }])(
    'rejects remote metadata hidden by a local alias: %j',
    async (remote) => {
      const fetchFn = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json({ version: '0.35.1' }))
        .mockResolvedValueOnce(Response.json({ ...LOCAL_SHOW, ...remote }))
      expect(await verifyOnDeviceServer(target('alias:latest'), { fetchFn })).toMatchObject({
        kind: 'refused',
      })
    },
  )

  it('accepts a bare -cloud name only after checking local metadata', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ version: '0.35.1' }))
      .mockResolvedValueOnce(Response.json(LOCAL_SHOW))
    expect(await verifyOnDeviceServer(target('local-cloud'), { fetchFn })).toBe('ok')
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it.each([{}, { details: {}, model_info: {} }, { modelfile: 'FROM local', details: {} }])(
    'fails closed on incomplete show data: %j',
    async (body) => {
      const fetchFn = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json({ version: '0.35.1' }))
        .mockResolvedValueOnce(Response.json(body))
      expect(await verifyOnDeviceServer(target(), { fetchFn })).toMatchObject({ kind: 'refused' })
    },
  )

  it('does not turn a failed Ollama check into a generic server success', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 503 }))
    expect(
      await verifyOnDeviceServer(target('local', 'openai-compatible'), { fetchFn }),
    ).toMatchObject({ kind: 'refused' })
  })

  it('requires explicit generic server attestation when its native API is absent', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response('', { status: 404 }))
    expect(await verifyOnDeviceServer(target(), { fetchFn })).toMatchObject({ kind: 'refused' })
    expect(await verifyOnDeviceServer(target('local', 'openai-compatible'), { fetchFn })).toBe('ok')
  })

  it('bounds untrusted model metadata', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ version: '0.35.1' }))
      .mockResolvedValueOnce(Response.json({ ...LOCAL_SHOW, modelfile: 'x'.repeat(1_048_577) }))
    expect(await verifyOnDeviceServer(target(), { fetchFn })).toMatchObject({ kind: 'refused' })
  })
})
