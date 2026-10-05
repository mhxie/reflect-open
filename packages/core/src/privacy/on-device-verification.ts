import { z } from 'zod'
import { onDeviceFetch } from '../ai/on-device-fetch.ts'
import type { OnDeviceServerVerdict, OnDeviceTarget } from './on-device.ts'

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

/** Optional caller cancellation and credentials; fetch is injectable only for verification tests. */
export interface OnDeviceVerificationOptions {
  apiKey?: string
  signal?: AbortSignal | undefined
  fetchFn?: typeof fetch
}

function refused(reason: string): OnDeviceServerVerdict {
  return { kind: 'refused', reason }
}

function nativeUrl(baseUrl: string, endpoint: string): string {
  const url = new URL(baseUrl)
  url.pathname = `${url.pathname.replace(/\/v1\/?$/u, '').replace(/\/$/u, '')}/api/${endpoint}`
  return url.href
}

async function readJson(response: Response, maximumBytes: number): Promise<unknown> {
  if (response.body === null) {
    throw new Error('Empty verification response')
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
        throw new Error('Verification response is too large')
      }
      text += decoder.decode(chunk.value, { stream: true })
    }
  } finally {
    await reader.cancel()
  }
}

/**
 * Check the exact selected model through the hardened loopback transport.
 * Ollama cloud references are refused before show, whose cloud-name path can
 * itself proxy off-device. Aliases are checked by remote metadata, not names.
 * Generic servers require an explicit server attestation when the native API
 * is absent; failed or ambiguous Ollama checks never become generic successes.
 */
export async function verifyOnDeviceServer(
  target: OnDeviceTarget,
  options: OnDeviceVerificationOptions = {},
): Promise<OnDeviceServerVerdict> {
  const tag = target.config.model.trim().split(':').at(-1)?.trim().toLowerCase() ?? ''
  if (
    target.config.model.includes(':') &&
    (tag === 'cloud' || (!tag.includes('/') && tag.endsWith('-cloud')))
  ) {
    return refused(
      'This model routes requests to Ollama cloud. Choose a model running on this Mac.',
    )
  }
  const timeout = AbortSignal.timeout(TIMEOUT_MS)
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout
  const fetchFn = options.fetchFn ?? onDeviceFetch
  const headers = new Headers()
  if (options.apiKey?.trim()) {
    headers.set('authorization', `Bearer ${options.apiKey}`)
  }
  try {
    const version = await fetchFn(nativeUrl(target.config.baseUrl, 'version'), { headers, signal })
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
    const parsedVersion = versionSchema.safeParse(await readJson(version, MAX_VERSION_BYTES))
    if (!parsedVersion.success) {
      return refused(
        'The local server returned an unrecognized verification response. Private content was not sent.',
      )
    }
    headers.set('content-type', 'application/json')
    const response = await fetchFn(nativeUrl(target.config.baseUrl, 'show'), {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: target.config.model, verbose: false }),
      signal,
    })
    if (!response.ok) {
      await response.body?.cancel()
      return refused('Ollama could not verify the selected model. Choose an installed local model.')
    }
    const parsed = showSchema.safeParse(await readJson(response, MAX_SHOW_BYTES))
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
