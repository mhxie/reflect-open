import { describe, expect, it, vi } from 'vitest'
import { listOllamaModels, OLLAMA_BASE_URL } from './ollama-models.ts'

function respond(body: string, status = 200): typeof fetch {
  return vi.fn<typeof fetch>(async () => new Response(body, { status }))
}

describe('listOllamaModels', () => {
  it('lists the installed models by name, leaving out the ones Ollama runs in the cloud', async () => {
    const fetchFn = respond(
      JSON.stringify({
        models: [
          { name: 'qwen3.8:27b', details: { parameter_size: '27.4B' } },
          { name: 'gemma4:31b', details: { parameter_size: '31.0B' } },
          { name: 'gpt-oss:120b-cloud', details: {} },
          { name: 'kimi-k3:cloud' },
          { name: 'aliased:latest', remote_host: 'https://ollama.com:443', remote_model: 'x' },
          { name: 'embed' },
        ],
      }),
    )

    expect(await listOllamaModels({ fetchFn })).toEqual({
      kind: 'ok',
      models: [
        { name: 'embed', parameterSize: null },
        { name: 'gemma4:31b', parameterSize: '31.0B' },
        { name: 'qwen3.8:27b', parameterSize: '27.4B' },
      ],
    })
    expect(fetchFn).toHaveBeenCalledWith('http://localhost:11434/api/tags', expect.anything())
    expect(OLLAMA_BASE_URL).toBe('http://localhost:11434/v1')
  })

  it('reports an empty install as ok with no models', async () => {
    expect(await listOllamaModels({ fetchFn: respond('{"models":[]}') })).toEqual({
      kind: 'ok',
      models: [],
    })
  })

  it('reads a server that is not running, failing, or not Ollama as unreachable', async () => {
    const refused = vi.fn<typeof fetch>(async () => {
      throw new TypeError('fetch failed')
    })
    expect(await listOllamaModels({ fetchFn: refused })).toEqual({ kind: 'unreachable' })
    expect(await listOllamaModels({ fetchFn: respond('nope', 500) })).toEqual({
      kind: 'unreachable',
    })
    expect(await listOllamaModels({ fetchFn: respond('{"data":[]}') })).toEqual({
      kind: 'unreachable',
    })
    expect(await listOllamaModels({ fetchFn: respond('not json') })).toEqual({
      kind: 'unreachable',
    })
  })

  it('refuses an oversized list instead of reading it whole', async () => {
    const huge = JSON.stringify({ models: [{ name: 'x'.repeat(1_100_000) }] })
    expect(await listOllamaModels({ fetchFn: respond(huge) })).toEqual({ kind: 'unreachable' })
  })

  it('asks the server the caller names', async () => {
    const fetchFn = respond('{"models":[]}')
    await listOllamaModels({ baseUrl: 'http://127.0.0.1:11500/v1', fetchFn })
    expect(fetchFn).toHaveBeenCalledWith('http://127.0.0.1:11500/api/tags', expect.anything())
  })

  it('rethrows the caller’s abort', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
      init?.signal?.throwIfAborted()
      return new Response('{"models":[]}')
    })
    await expect(listOllamaModels({ fetchFn, signal: controller.signal })).rejects.toThrow()
  })
})
