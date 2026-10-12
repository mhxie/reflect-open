import { describe, expect, it, vi } from 'vitest'
import { listOllamaModels, OLLAMA_BASE_URL } from './ollama-models.ts'

function respond(body: string, status = 200): typeof fetch {
  return vi.fn<typeof fetch>(async () => new Response(body, { status }))
}

/** A fake Ollama: `/api/tags` lists `tags`; `/api/show` answers per model. */
function ollama(
  tags: object[],
  show: (model: string) => Response = () => new Response('{}'),
): typeof fetch {
  return vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith('/api/tags')) {
      return new Response(JSON.stringify({ models: tags }))
    }
    const { model } = JSON.parse(String(init?.body)) as { model: string }
    return show(model)
  })
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

  it('leaves out models that cannot write text, like embedding models', async () => {
    const fetchFn = ollama(
      [
        { name: 'nomic-embed-text:latest' },
        { name: 'gemma4:31b' },
        { name: 'older-server:latest' },
        { name: 'flaky:latest' },
      ],
      (model) => {
        if (model === 'nomic-embed-text:latest') {
          return new Response(JSON.stringify({ capabilities: ['embedding'] }))
        }
        if (model === 'gemma4:31b') {
          return new Response(JSON.stringify({ capabilities: ['completion', 'vision'] }))
        }
        if (model === 'flaky:latest') {
          return new Response('busy', { status: 500 })
        }
        return new Response(JSON.stringify({ modelfile: 'FROM x' }))
      },
    )

    const listed = await listOllamaModels({ fetchFn })

    // A server that reports no capabilities, or a look that fails, keeps the model.
    expect(listed).toEqual({
      kind: 'ok',
      models: [
        { name: 'flaky:latest', parameterSize: null },
        { name: 'gemma4:31b', parameterSize: null },
        { name: 'older-server:latest', parameterSize: null },
      ],
    })
    expect(fetchFn).toHaveBeenCalledWith(
      'http://localhost:11434/api/show',
      expect.objectContaining({ method: 'POST' }),
    )
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
