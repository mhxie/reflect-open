import { z } from 'zod'
import { toAppError } from '../errors.ts'
import { call } from '../ipc/invoke.ts'
import { bytesToBase64 } from '../lib/base64.ts'
import { isLoopbackHttpUrl } from '../privacy/loopback.ts'

/**
 * `fetch` for model servers on this Mac, over the Rust transport in
 * `src-tauri/src/on_device_http.rs`: no proxy, no redirects, `localhost`
 * pinned to 127.0.0.1, and a loopback check on the peer that answered.
 * `languageModel` and `validateApiKey` use it for every loopback
 * OpenAI-compatible endpoint, whatever fetch their caller passed, so no call
 * site can send one through the webview's or the HTTP plugin's network stack.
 *
 * `on_device_http_send` returns the response head; the body is pulled chunk
 * by chunk with `on_device_http_read` (an empty chunk ends it); an abort or a
 * cancelled body stops the request with `on_device_http_cancel`.
 */

const responseHeadSchema = z.object({
  status: z.number().int(),
  statusText: z.string(),
  headers: z.array(z.tuple([z.string(), z.string()])),
})

const voidSchema = z.null()

/**
 * Statuses whose responses have no body. The Fetch standard also lists 101
 * and 103, but nothing outside 200–599 can form a `Response` at all; those
 * are refused before this set is consulted.
 */
const NULL_BODY_STATUSES = new Set([204, 205, 304])

/** How a request body crosses the JSON IPC (`RequestBody` in Rust). */
type RequestBodyArg = { kind: 'text'; text: string } | { kind: 'base64'; data: string }

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError')
}

/**
 * The rejection fetch callers expect when the transport fails: a network
 * failure reads as fetch's own `TypeError('fetch failed')`, which the AI SDK
 * reports as "Cannot connect to API: …".
 */
function transportError(error: unknown): TypeError {
  const appError = toAppError(error)
  return appError.kind === 'network'
    ? new TypeError('fetch failed', { cause: new Error(appError.message) })
    : new TypeError(appError.message)
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input
  }
  return input instanceof URL ? input.href : input.url
}

async function requestBody(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): Promise<RequestBodyArg | null> {
  let body: BodyInit | null | undefined = init?.body
  if (body === undefined && input instanceof Request && input.body !== null) {
    body = new Uint8Array(await input.arrayBuffer())
  }
  if (body === undefined || body === null) {
    return null
  }
  if (typeof body === 'string') {
    return { kind: 'text', text: body }
  }
  if (body instanceof Uint8Array) {
    return { kind: 'base64', data: bytesToBase64(body) }
  }
  throw new TypeError('onDeviceFetch sends only string or Uint8Array bodies')
}

/** Resolve with `promise`, or reject with an `AbortError` (after `onAbort`) once `signal` aborts. */
async function untilAborted<T>(
  promise: Promise<T>,
  signal: AbortSignal | null,
  onAbort: () => void,
): Promise<T> {
  if (signal === null) {
    return await promise
  }
  return await new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      onAbort()
      reject(abortError())
    }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      },
    )
  })
}

/** The body as a stream pulled from `on_device_http_read`, until the empty end chunk. */
function responseBody(
  requestId: string,
  signal: AbortSignal | null,
  cancel: () => void,
): ReadableStream<Uint8Array> {
  let settled = false
  let onAbort: (() => void) | null = null
  const settle = (): void => {
    settled = true
    if (onAbort !== null) {
      signal?.removeEventListener('abort', onAbort)
    }
  }
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (signal === null) {
        return
      }
      onAbort = () => {
        settle()
        cancel()
        controller.error(abortError())
      }
      // The signal may have aborted between the head arriving and now.
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    },
    async pull(controller) {
      let chunk: ArrayBuffer
      try {
        chunk = await call('on_device_http_read', { requestId }, z.instanceof(ArrayBuffer))
      } catch (error) {
        if (!settled) {
          settle()
          controller.error(transportError(error))
        }
        return
      }
      if (settled) {
        return
      }
      if (chunk.byteLength === 0) {
        settle()
        controller.close()
        return
      }
      controller.enqueue(new Uint8Array(chunk))
    },
    cancel() {
      settle()
      cancel()
    },
  })
}

/**
 * A `fetch` that reaches only this Mac: it refuses any URL that is not
 * http(s) to `localhost`, 127.0.0.0/8 or `[::1]` before touching the bridge,
 * and the Rust side checks again. Bodies must be a string or a `Uint8Array`.
 * Desktop only: the browser dev bridge answers with a "needs the desktop app"
 * error, which surfaces as the rejection.
 */
export const onDeviceFetch: typeof fetch = async (input, init) => {
  const url = requestUrl(input)
  if (!isLoopbackHttpUrl(url)) {
    throw new TypeError(
      'onDeviceFetch only reaches servers on this Mac (localhost, 127.x.x.x or [::1])',
    )
  }
  const signal = init?.signal ?? (input instanceof Request ? input.signal : null)
  if (signal?.aborted) {
    throw abortError()
  }
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
  const headers: Array<[string, string]> = []
  new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).forEach(
    (value, name) => {
      headers.push([name, value])
    },
  )
  const body = await requestBody(input, init)

  const requestId = crypto.randomUUID()
  const cancel = (): void => {
    call('on_device_http_cancel', { requestId }, voidSchema).catch(() => {})
  }
  const sent = call(
    'on_device_http_send',
    { requestId, method, url, headers, body },
    responseHeadSchema,
  ).catch((error: unknown) => {
    throw transportError(error)
  })
  const head = await untilAborted(sent, signal, cancel)

  if (head.status < 200 || head.status > 599) {
    cancel()
    throw new TypeError(`the server on this Mac answered with status ${head.status}`)
  }
  const responseInit = { status: head.status, statusText: head.statusText, headers: head.headers }
  if (NULL_BODY_STATUSES.has(head.status)) {
    // No read will ever reach the end of this body, so free it now.
    cancel()
    return new Response(null, responseInit)
  }
  return new Response(responseBody(requestId, signal, cancel), responseInit)
}
