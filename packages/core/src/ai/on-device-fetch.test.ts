import { afterEach, describe, expect, it, vi } from 'vitest'
import { setBridge, type IpcBridge } from '../ipc/bridge.ts'
import { fakeOnDeviceServer } from '../testing/fake-on-device-server.ts'
import { onDeviceFetch } from './on-device-fetch.ts'

const URL_ON_THIS_MAC = 'http://localhost:11434/v1/chat/completions'
const OK_HEAD = { status: 200, statusText: 'OK', headers: [] }

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {}
  let reject: (reason: unknown) => void = () => {}
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

/** A bridge driven by `invoke`, recording every command with its args. */
function recordingBridge(invoke: IpcBridge['invoke']): {
  calls: Array<{ command: string; args: Record<string, unknown> }>
} {
  const calls: Array<{ command: string; args: Record<string, unknown> }> = []
  setBridge({
    invoke: async (command, args) => {
      calls.push({ command, args })
      return await invoke(command, args)
    },
    listen: async () => () => {},
  })
  return { calls }
}

function commands(calls: Array<{ command: string }>): string[] {
  return calls.map((call) => call.command)
}

afterEach(() => {
  setBridge(null)
})

describe('onDeviceFetch', () => {
  it('maps method, URL, headers and a text body onto on_device_http_send', async () => {
    const server = fakeOnDeviceServer(() => ({
      headers: [['content-type', 'application/json']],
      chunks: ['{"ok":true}'],
    }))
    setBridge(server.bridge)

    const response = await onDeviceFetch(URL_ON_THIS_MAC, {
      method: 'post',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer local-key' },
      body: '{"model":"llama3"}',
    })

    expect(response.status).toBe(200)
    expect(response.statusText).toBe('OK')
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(await response.json()).toEqual({ ok: true })
    expect(server.requests).toEqual([
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
    const server = fakeOnDeviceServer(() => ({}))
    setBridge(server.bridge)

    await onDeviceFetch(new URL('http://127.0.0.1:1234/v1/models'))
    await onDeviceFetch(
      new Request('http://[::1]:1234/v1/embeddings', {
        method: 'POST',
        headers: { 'X-Probe': '1' },
        body: new Uint8Array([104, 105]),
      }),
    )
    await onDeviceFetch('http://localhost:1234/v1/audio', {
      method: 'POST',
      body: new Uint8Array([0, 255]),
    })

    expect(server.requests.map(({ method, url, body }) => ({ method, url, body }))).toEqual([
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
    expect(server.requests[1]!.headers).toContainEqual(['x-probe', '1'])
    const requestIds = new Set(server.requests.map((request) => request.requestId))
    expect(requestIds.size).toBe(3)
  })

  it('assembles a chunked body in order and closes it at the empty end chunk', async () => {
    const server = fakeOnDeviceServer(() => ({
      chunks: ['data: {"a"', ':1}\n\n', 'data: [DONE]\n\n'],
    }))
    setBridge(server.bridge)

    const response = await onDeviceFetch(URL_ON_THIS_MAC, { method: 'POST', body: '{}' })
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
    expect(server.cancelled).toEqual([])
  })

  it('cancels and rejects with an AbortError when aborted before the head', async () => {
    const head = deferred<unknown>()
    const { calls } = recordingBridge(async (command) =>
      command === 'on_device_http_send' ? await head.promise : null,
    )
    const controller = new AbortController()

    const pending = onDeviceFetch(URL_ON_THIS_MAC, { signal: controller.signal })
    await vi.waitFor(() => expect(commands(calls)).toContain('on_device_http_send'))
    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    const [send, cancel] = calls
    expect(cancel).toEqual({
      command: 'on_device_http_cancel',
      args: { requestId: send!.args['requestId'] },
    })
    // A head that arrives after the abort changes nothing.
    head.resolve(OK_HEAD)
    await Promise.resolve()
    expect(commands(calls)).toEqual(['on_device_http_send', 'on_device_http_cancel'])
  })

  it('cancels and errors the body when aborted mid-stream', async () => {
    let waitingRead: Deferred<ArrayBuffer> | null = null
    const { calls } = recordingBridge(async (command) => {
      switch (command) {
        case 'on_device_http_send':
          return OK_HEAD
        case 'on_device_http_read':
          if (waitingRead === null) {
            waitingRead = deferred<ArrayBuffer>()
            return new TextEncoder().encode('hello').buffer
          }
          return await waitingRead.promise
        case 'on_device_http_cancel':
          // The Rust side fails the read that was waiting.
          waitingRead?.reject({ kind: 'io', message: 'the on-device request was cancelled' })
          return null
        default:
          throw new Error(command)
      }
    })
    const controller = new AbortController()

    const response = await onDeviceFetch(URL_ON_THIS_MAC, { signal: controller.signal })
    const reader = response.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('hello')
    const next = reader.read()
    await vi.waitFor(() =>
      expect(commands(calls).filter((command) => command === 'on_device_http_read')).toHaveLength(
        2,
      ),
    )
    controller.abort()

    await expect(next).rejects.toMatchObject({ name: 'AbortError' })
    expect(commands(calls).filter((command) => command === 'on_device_http_cancel')).toHaveLength(1)
  })

  it('cancels the request when the reader cancels the body', async () => {
    const server = fakeOnDeviceServer(() => ({ chunks: ['a', 'b', 'c'] }))
    setBridge(server.bridge)

    const response = await onDeviceFetch(URL_ON_THIS_MAC)
    await response.body!.cancel()

    expect(server.cancelled).toEqual([server.requests[0]!.requestId])
    expect(server.openRequests()).toEqual([])
  })

  it('refuses anything but a loopback URL without touching the bridge', async () => {
    const invoke = vi.fn<IpcBridge['invoke']>()
    setBridge({ invoke, listen: async () => () => {} })

    for (const url of [
      'http://192.168.1.5:1234/v1/models',
      'https://api.openai.com/v1/models',
      'http://localhost.:11434/v1/models',
      'http://user:secret@localhost:11434/v1/models',
      'http://[::ffff:127.0.0.1]:11434/v1/models',
    ]) {
      await expect(onDeviceFetch(url), url).rejects.toBeInstanceOf(TypeError)
    }
    expect(invoke).not.toHaveBeenCalled()
  })

  it('rejects an already-aborted signal and unsupported bodies without touching the bridge', async () => {
    const invoke = vi.fn<IpcBridge['invoke']>()
    setBridge({ invoke, listen: async () => () => {} })

    await expect(
      onDeviceFetch(URL_ON_THIS_MAC, { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    await expect(
      onDeviceFetch(URL_ON_THIS_MAC, { method: 'POST', body: new Blob(['x']) }),
    ).rejects.toBeInstanceOf(TypeError)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('frees a body-less response at once and refuses statuses no Response can carry', async () => {
    const server = fakeOnDeviceServer((request) => ({
      status: request.url.endsWith('/empty') ? 204 : 101,
    }))
    setBridge(server.bridge)

    const empty = await onDeviceFetch('http://localhost:11434/empty')
    expect(empty.status).toBe(204)
    expect(empty.body).toBeNull()
    await expect(onDeviceFetch('http://localhost:11434/upgrade')).rejects.toBeInstanceOf(TypeError)
    expect(server.cancelled).toEqual(server.requests.map((request) => request.requestId))
  })

  it('reports transport failures the way fetch does', async () => {
    recordingBridge(async () => {
      throw { kind: 'network', message: 'error sending request: Connection refused (os error 61)' }
    })
    const refused = await onDeviceFetch(URL_ON_THIS_MAC).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(TypeError)
    expect(refused).toMatchObject({
      message: 'fetch failed',
      cause: { message: 'error sending request: Connection refused (os error 61)' },
    })

    recordingBridge(async () => {
      throw { kind: 'unsupported', message: 'Reaching a model on this Mac needs the desktop app.' }
    })
    await expect(onDeviceFetch(URL_ON_THIS_MAC)).rejects.toMatchObject({
      name: 'TypeError',
      message: 'Reaching a model on this Mac needs the desktop app.',
    })
  })
})
