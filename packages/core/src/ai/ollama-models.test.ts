import { describe, expect, it } from 'vitest'
import { createTestHttpService, type TestHttpReply } from '../testing/http.ts'
import { listOllamaModels, OLLAMA_BASE_URL } from './ollama-models.ts'

const TAGS_URL = 'http://localhost:11434/api/tags'
const SHOW_URL = 'http://localhost:11434/api/show'

/** A server answering every request with `reply`. */
function respond(body: string, status = 200) {
  return createTestHttpService([
    { method: '*', url: () => true, reply: () => new Response(body, { status }) },
  ])
}

/** A fake Ollama: `/api/tags` lists `tags`; `/api/show` answers per model. */
function ollama(
  tags: object[],
  show: (model: string) => Response = () => new Response('{}'),
): ReturnType<typeof createTestHttpService> {
  const showReply: TestHttpReply = async (request) => {
    const { model } = JSON.parse(await request.text()) as { model: string }
    return show(model)
  }
  return createTestHttpService([
    { method: 'GET', url: TAGS_URL, reply: { status: 200, json: { models: tags } } },
    { method: 'POST', url: SHOW_URL, reply: showReply },
  ])
}

describe('listOllamaModels', () => {
  it('lists the installed models by name, leaving out the ones Ollama runs in the cloud', async () => {
    const http = ollama([
      { name: 'qwen3.8:27b', details: { parameter_size: '27.4B' } },
      { name: 'gemma4:31b', details: { parameter_size: '31.0B' } },
      { name: 'gpt-oss:120b-cloud', details: {} },
      { name: 'kimi-k3:cloud' },
      { name: 'aliased:latest', remote_host: 'https://ollama.com:443', remote_model: 'x' },
      { name: 'embed' },
    ])

    expect(await listOllamaModels(http)).toEqual({
      kind: 'ok',
      models: [
        { name: 'embed', parameterSize: null },
        { name: 'gemma4:31b', parameterSize: '31.0B' },
        { name: 'qwen3.8:27b', parameterSize: '27.4B' },
      ],
    })
    expect(http.requests()[0]?.url).toBe(TAGS_URL)
    expect(OLLAMA_BASE_URL).toBe('http://localhost:11434/v1')
  })

  it('leaves out models that cannot write text, like embedding models', async () => {
    const http = ollama(
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

    const listed = await listOllamaModels(http)

    // A server that reports no capabilities, or a look that fails, keeps the model.
    expect(listed).toEqual({
      kind: 'ok',
      models: [
        { name: 'flaky:latest', parameterSize: null },
        { name: 'gemma4:31b', parameterSize: null },
        { name: 'older-server:latest', parameterSize: null },
      ],
    })
    expect(
      http
        .requests()
        .filter((request) => request.url === SHOW_URL)
        .map((request) => request.method),
    ).toEqual(['POST', 'POST', 'POST', 'POST'])
  })

  it('reports an empty install as ok with no models', async () => {
    expect(await listOllamaModels(respond('{"models":[]}'))).toEqual({
      kind: 'ok',
      models: [],
    })
  })

  it('reads a server that is not running, failing, or not Ollama as unreachable', async () => {
    const refused = createTestHttpService([
      {
        method: '*',
        url: () => true,
        reply: () => {
          throw new TypeError('fetch failed')
        },
      },
    ])
    expect(await listOllamaModels(refused)).toEqual({ kind: 'unreachable' })
    expect(await listOllamaModels(respond('nope', 500))).toEqual({ kind: 'unreachable' })
    expect(await listOllamaModels(respond('{"data":[]}'))).toEqual({ kind: 'unreachable' })
    expect(await listOllamaModels(respond('not json'))).toEqual({ kind: 'unreachable' })
  })

  it('refuses an oversized list instead of reading it whole', async () => {
    const huge = JSON.stringify({ models: [{ name: 'x'.repeat(1_100_000) }] })
    expect(await listOllamaModels(respond(huge))).toEqual({ kind: 'unreachable' })
  })

  it('rethrows the caller’s abort', async () => {
    const controller = new AbortController()
    controller.abort()
    const http = createTestHttpService([
      {
        method: '*',
        url: () => true,
        reply: (request) => {
          request.signal.throwIfAborted()
          return new Response('{"models":[]}')
        },
      },
    ])
    await expect(listOllamaModels(http, { signal: controller.signal })).rejects.toThrow()
  })
})
