import { z } from 'zod'
import type { IpcBridge } from '../ipc/bridge.ts'

/**
 * Test-only stand-in for the Rust `on_device_http` transport behind
 * `onDeviceFetch`: install `server.bridge` with `setBridge`, answer each
 * request from `respond`, then inspect what reached the "server".
 */

const sendArgsSchema = z.object({
  requestId: z.string(),
  method: z.string(),
  url: z.string(),
  headers: z.array(z.tuple([z.string(), z.string()])),
  body: z.union([
    z.object({ kind: z.literal('text'), text: z.string() }),
    z.object({ kind: z.literal('base64'), data: z.string() }),
    z.null(),
  ]),
})

const requestIdArgsSchema = z.object({ requestId: z.string() })

/** A request as `on_device_http_send` received it. */
export type FakeOnDeviceRequest = z.infer<typeof sendArgsSchema>

/** How the fake server answers one request. */
export interface FakeOnDeviceResponse {
  status?: number
  statusText?: string
  headers?: Array<[string, string]>
  /** The body, one `on_device_http_read` per chunk. */
  chunks?: string[]
}

export interface FakeOnDeviceServer {
  bridge: IpcBridge
  /** Every request sent, in order. */
  requests: FakeOnDeviceRequest[]
  /** Request ids `on_device_http_cancel` named, in order. */
  cancelled: string[]
  /** Ids whose body was neither read to its end nor cancelled. */
  openRequests: () => string[]
}

function arrayBufferOf(text: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(text)
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
}

/** A fake on-device server answering every request with `respond`. */
export function fakeOnDeviceServer(
  respond: (request: FakeOnDeviceRequest) => FakeOnDeviceResponse,
): FakeOnDeviceServer {
  const requests: FakeOnDeviceRequest[] = []
  const cancelled: string[] = []
  const bodies = new Map<string, string[]>()
  const bridge: IpcBridge = {
    invoke: async (command, args) => {
      switch (command) {
        case 'on_device_http_send': {
          const request = sendArgsSchema.parse(args)
          requests.push(request)
          const response = respond(request)
          bodies.set(request.requestId, [...(response.chunks ?? [])])
          return {
            status: response.status ?? 200,
            statusText: response.statusText ?? 'OK',
            headers: response.headers ?? [],
          }
        }
        case 'on_device_http_read': {
          const { requestId } = requestIdArgsSchema.parse(args)
          const chunks = bodies.get(requestId)
          if (chunks === undefined) {
            throw { kind: 'notFound', message: 'no such on-device request' }
          }
          const chunk = chunks.shift()
          if (chunk === undefined) {
            bodies.delete(requestId)
            return new ArrayBuffer(0)
          }
          return arrayBufferOf(chunk)
        }
        case 'on_device_http_cancel': {
          const { requestId } = requestIdArgsSchema.parse(args)
          cancelled.push(requestId)
          bodies.delete(requestId)
          return null
        }
        default:
          throw new Error(`the fake on-device server does not answer "${command}"`)
      }
    },
    listen: async () => () => {},
  }
  return { bridge, requests, cancelled, openRequests: () => [...bodies.keys()] }
}
