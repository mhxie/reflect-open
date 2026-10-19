import { timeoutSignal } from '@reflect/utils'
import { z } from 'zod'
import type { HttpService } from '../ports/http-service.ts'
import type { OnDeviceTarget } from './on-device-target.ts'

/**
 * A refusal from {@link verifyOnDeviceServer}, with the reason to show.
 */
export interface OnDeviceServerRefusal {
  readonly kind: 'refused'
  readonly reason: string
}

/**
 * What {@link verifyOnDeviceServer} concluded about the server behind a target.
 */
export type OnDeviceServerVerdict = 'ok' | OnDeviceServerRefusal

const TIMEOUT_MS = 5_000
const MAX_VERSION_BYTES = 16_384
const MAX_SHOW_BYTES = 1_048_576

const versionSchema = z.object({ version: z.string().min(1) })
const showSchema = z.object({
  modelfile: z.string().min(1),
  details: z.record(z.string(), z.unknown()),
  model_info: z.record(z.string(), z.unknown()),
  remote_host: z.string().optional(),
  remote_model: z.string().optional(),
})

/**
 * Optional caller cancellation and credentials.
 */
export interface OnDeviceVerificationOptions {
  apiKey?: string | undefined
  signal?: AbortSignal | undefined
}

function refused(reason: string): OnDeviceServerVerdict {
  return { kind: 'refused', reason }
}

/**
 * Ollama's native endpoint (`/api/<endpoint>`) beside an OpenAI-compatible base URL.
 */
export function ollamaNativeUrl(baseUrl: string, endpoint: string): string {
  const url = new URL(baseUrl)
  url.pathname = `${url.pathname.replace(/\/v1\/?$/u, '').replace(/\/$/u, '')}/api/${endpoint}`
  return url.href
}

/**
 * Parse a local server's JSON body, refusing one larger than `maximumBytes`.
 * The body is always released, so the request's transport slot is too.
 */
export async function readBoundedJson(response: Response, maximumBytes: number): Promise<unknown> {
  if (response.body === null) {
    throw new Error('Empty local server response')
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let size = 0
  let text = ''
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) {
        return JSON.parse(text + decoder.decode())
      }
      size += chunk.value.byteLength
      if (size > maximumBytes) {
        throw new Error('Local server response is too large')
      }
      text += decoder.decode(chunk.value, { stream: true })
    }
  } finally {
    await reader.cancel()
  }
}

/**
 * Whether an Ollama model name is tagged as a cloud model (`:cloud`,
 * `:<size>-cloud`): Ollama forwards those off this Mac.
 */
export function isOllamaCloudModel(model: string): boolean {
  const tag = model.trim().split(':').at(-1)?.trim().toLowerCase() ?? ''
  return model.includes(':') && (tag === 'cloud' || (!tag.includes('/') && tag.endsWith('-cloud')))
}

/**
 * Check the exact selected model through `http`, the hardened loopback
 * transport (`OnDeviceHttpService`). Ollama cloud references are refused
 * before show, whose cloud-name path can itself proxy off-device. Aliases are
 * checked by remote metadata, not names. Generic servers require an explicit
 * server attestation when the native API is absent; failed or ambiguous
 * Ollama checks never become generic successes.
 */
export async function verifyOnDeviceServer(
  http: HttpService,
  target: OnDeviceTarget,
  options: OnDeviceVerificationOptions = {},
): Promise<OnDeviceServerVerdict> {
  if (isOllamaCloudModel(target.config.model)) {
    return refused(
      'This model routes requests to Ollama cloud. Choose a model running on this Mac.',
    )
  }
  const signal = timeoutSignal(TIMEOUT_MS, options.signal)
  const headers = new Headers()
  if (options.apiKey?.trim()) {
    headers.set('authorization', `Bearer ${options.apiKey}`)
  }
  try {
    const version = await http.fetch(ollamaNativeUrl(target.config.baseUrl, 'version'), {
      headers,
      signal,
    })
    if (version.status === 404 && target.config.onDevice?.server === 'openai-compatible') {
      await version.body?.cancel()
      return 'ok'
    }
    if (!version.ok) {
      await version.body?.cancel()
      return refused(
        'Cannot verify this local server. Confirm its server type in Settings → AI providers.',
      )
    }
    const parsedVersion = versionSchema.safeParse(await readBoundedJson(version, MAX_VERSION_BYTES))
    if (!parsedVersion.success) {
      return refused(
        'The local server returned an unrecognized verification response. Private content was not sent.',
      )
    }
    headers.set('content-type', 'application/json')
    const response = await http.fetch(ollamaNativeUrl(target.config.baseUrl, 'show'), {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: target.config.model, verbose: false }),
      signal,
    })
    if (!response.ok) {
      await response.body?.cancel()
      return refused('Ollama could not verify the selected model. Choose an installed local model.')
    }
    const parsed = showSchema.safeParse(await readBoundedJson(response, MAX_SHOW_BYTES))
    if (!parsed.success) {
      return refused(
        'Ollama returned an unrecognized model description. Private content was not sent.',
      )
    }
    if (parsed.data.remote_host?.trim() || parsed.data.remote_model?.trim()) {
      return refused('Ollama routes this model off this Mac. Choose an installed local model.')
    }
    return 'ok'
  } catch {
    options.signal?.throwIfAborted()
    return refused(
      'Could not verify the local model before reading private content. Check the server and try again.',
    )
  }
}
