import { describe, expect, it, vi } from 'vitest'
import { AppError } from '../errors.ts'
import { createTestOnDeviceHttpService } from '../testing/ai.ts'
import { createTestIdService } from '../testing/id.ts'
import { createTestIpcBridgeService } from '../testing/ipc.ts'
import { createOnDeviceHttpService } from './on-device-http-service.ts'

const URL_ON_THIS_MAC = 'http://localhost:11434/v1/chat/completions'
const OK_HEAD = { status: 200, statusText: 'OK', headers: [] }

/** The real transport over IPC answered by `invoke`, recording every command. */
function scripted(invoke: (command: string) => unknown) {
  const ipc = createTestIpcBridgeService({
    commands: {
      on_device_http_send: () => invoke('on_device_http_send'),
      on_device_http_read: () => invoke('on_device_http_read'),
      on_device_http_cancel: () => invoke('on_device_http_cancel'),
    },
  })
  return { ipc, http: createOnDeviceHttpService({ ipc, id: createTestIdService() }) }
}

function commands(ipc: ReturnType<typeof createTestIpcBridgeService>): string[] {
  return ipc.calls().map((call) => call.command)
}

describe('OnDeviceHttpService', () => {
  it('maps method, URL, headers and a text body onto on_device_http_send', async () => {
    const server = createTestOnDeviceHttpService(() => ({
      headers: [['content-type', 'application/json']],
      chunks: ['{"ok":true}'],
    }))

    const response = await server.fetch(URL_ON_THIS_MAC, {
      method: 'post',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer local-key' },
      body: '{"model":"llama3"}',
    })

    expect(response.status).toBe(200)
    expect(response.statusText).toBe('OK')
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(await response.json()).toEqual({ ok: true })
    expect(server.requests()).toEqual([
      {
        requestId: expect.any(String),
        method: 'POST',
        url: URL_ON_THIS_MAC,
        headers: [
          ['authorization', 'Bearer local-key'],
          ['content-type', 'application/json'],
        ],
        body: { kind: 'text', text: '{"model":"llama3"}' },
      },
    ])
  })

  it('accepts a URL or a Request and sends bytes as base64', async () => {
    const server = createTestOnDeviceHttpService()

    await server.fetch(new URL('http://127.0.0.1:1234/v1/models'))
    await server.fetch(
      new Request('http://[::1]:1234/v1/embeddings', {
        method: 'POST',
        headers: { 'X-Probe': '1' },
        body: new Uint8Array([104, 105]),
      }),
    )
    await server.fetch('http://localhost:1234/v1/audio', {
      method: 'POST',
      body: new Uint8Array([0, 255]),
    })

    expect(server.requests().map(({ method, url, body }) => ({ method, url, body }))).toEqual([
      { method: 'GET', url: 'http://127.0.0.1:1234/v1/models', body: null },
      {
        method: 'POST',
        url: 'http://[::1]:1234/v1/embeddings',
        body: { kind: 'base64', data: 'aGk=' },
      },
      {
        method: 'POST',
        url: 'http://localhost:1234/v1/audio',
        body: { kind: 'base64', data: 'AP8=' },
      },
    ])
    expect(server.requests()[1]!.headers).toContainEqual(['x-probe', '1'])
    const requestIds = new Set(server.requests().map((request) => request.requestId))
    expect(requestIds.size).toBe(3)
  })

  it('assembles a chunked body in order and closes it at the empty end chunk', async () => {
    const server = createTestOnDeviceHttpService(() => ({
      chunks: ['data: {"a"', ':1}\n\n', 'data: [DONE]\n\n'],
    }))

    const response = await server.fetch(URL_ON_THIS_MAC, { method: 'POST', body: '{}' })
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let text = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      text += decoder.decode(value, { stream: true })
    }

    expect(text).toBe('data: {"a":1}\n\ndata: [DONE]\n\n')
    expect(server.openRequests()).toEqual([])
    expect(server.cancelled()).toEqual([])
  })

  it('cancels and rejects with an AbortError when aborted before the head', async () => {
    const head = Promise.withResolvers<unknown>()
    const { ipc, http } = scripted(async (command) =>
      command === 'on_device_http_send' ? await head.promise : null,
    )
    const controller = new AbortController()

    const pending = http.fetch(URL_ON_THIS_MAC, { signal: controller.signal })
    await vi.waitFor(() => expect(commands(ipc)).toContain('on_device_http_send'))
    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    const [send, cancel] = ipc.calls()
    expect(cancel).toEqual({
      command: 'on_device_http_cancel',
      args: { requestId: send!.args['requestId'] },
    })
    // A head that arrives after the abort changes nothing.
    head.resolve(OK_HEAD)
    await head.promise
    expect(commands(ipc)).toEqual(['on_device_http_send', 'on_device_http_cancel'])
  })

  it('cancels and errors the body when aborted mid-stream', async () => {
    let waitingRead: PromiseWithResolvers<ArrayBuffer> | null = null
    const { ipc, http } = scripted(async (command) => {
      switch (command) {
        case 'on_device_http_send':
          return OK_HEAD
        case 'on_device_http_read':
          if (waitingRead === null) {
            waitingRead = Promise.withResolvers<ArrayBuffer>()
            return new TextEncoder().encode('hello').buffer
          }
          return await waitingRead.promise
        case 'on_device_http_cancel':
          // The Rust side fails the read that was waiting.
          waitingRead?.reject(new AppError('io', 'the on-device request was cancelled'))
          return null
        default:
          throw new Error(command)
      }
    })
    const controller = new AbortController()

    const response = await http.fetch(URL_ON_THIS_MAC, { signal: controller.signal })
    const reader = response.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('hello')
    const next = reader.read()
    await vi.waitFor(() =>
      expect(commands(ipc).filter((command) => command === 'on_device_http_read')).toHaveLength(2),
    )
    controller.abort()

    await expect(next).rejects.toMatchObject({ name: 'AbortError' })
    expect(commands(ipc).filter((command) => command === 'on_device_http_cancel')).toHaveLength(1)
  })

  it('cancels the request when the reader cancels the body', async () => {
    const server = createTestOnDeviceHttpService(() => ({ chunks: ['a', 'b', 'c'] }))

    const response = await server.fetch(URL_ON_THIS_MAC)
    await response.body!.cancel()

    expect(server.cancelled()).toEqual([server.requests()[0]!.requestId])
    expect(server.openRequests()).toEqual([])
  })

  it('refuses anything but a loopback URL without touching the bridge', async () => {
    const { ipc, http } = scripted(() => OK_HEAD)

    for (const url of [
      'http://192.168.1.5:1234/v1/models',
      'https://api.openai.com/v1/models',
      'http://localhost.:11434/v1/models',
      'http://user:secret@localhost:11434/v1/models',
      'http://[::ffff:127.0.0.1]:11434/v1/models',
    ]) {
      await expect(http.fetch(url), url).rejects.toBeInstanceOf(TypeError)
    }
    expect(ipc.calls()).toEqual([])
  })

  it('rejects an already-aborted signal and unsupported bodies without touching the bridge', async () => {
    const { ipc, http } = scripted(() => OK_HEAD)

    await expect(
      http.fetch(URL_ON_THIS_MAC, { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    await expect(
      http.fetch(URL_ON_THIS_MAC, { method: 'POST', body: new Blob(['x']) }),
    ).rejects.toBeInstanceOf(TypeError)
    expect(ipc.calls()).toEqual([])
  })

  it('frees a body-less response at once and refuses statuses no Response can carry', async () => {
    const server = createTestOnDeviceHttpService((request) => ({
      status: request.url.endsWith('/empty') ? 204 : 101,
    }))

    const empty = await server.fetch('http://localhost:11434/empty')
    expect(empty.status).toBe(204)
    expect(empty.body).toBeNull()
    await expect(server.fetch('http://localhost:11434/upgrade')).rejects.toBeInstanceOf(TypeError)
    expect(server.cancelled()).toEqual(server.requests().map((request) => request.requestId))
  })

  it('reports transport failures the way fetch does', async () => {
    const refused = scripted(() => {
      throw new AppError('network', 'error sending request: Connection refused (os error 61)')
    }).http
    const failure = await refused.fetch(URL_ON_THIS_MAC).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(TypeError)
    expect(failure).toMatchObject({
      message: 'fetch failed',
      cause: { message: 'error sending request: Connection refused (os error 61)' },
    })

    const browser = scripted(() => {
      throw new AppError('unsupported', 'Reaching a model on this Mac needs the desktop app.')
    }).http
    await expect(browser.fetch(URL_ON_THIS_MAC)).rejects.toMatchObject({
      name: 'TypeError',
      message: 'Reaching a model on this Mac needs the desktop app.',
    })
  })
})
