import { z } from 'zod'
import {
  isOllamaCloudModel,
  ollamaNativeUrl,
  readBoundedJson,
} from '../privacy/on-device-verification.ts'
import { onDeviceFetch } from './on-device-fetch.ts'

/** Where Ollama serves its OpenAI-compatible API on this Mac by default. */
export const OLLAMA_BASE_URL = 'http://localhost:11434/v1'

const TIMEOUT_MS = 5_000
const MAX_TAGS_BYTES = 1_048_576
const MAX_SHOW_BYTES = 1_048_576

const tagsSchema = z.object({
  models: z.array(
    z.object({
      name: z.string().min(1),
      details: z.object({ parameter_size: z.string().optional() }).optional(),
      remote_host: z.string().optional(),
      remote_model: z.string().optional(),
    }),
  ),
})

const showSchema = z.object({ capabilities: z.array(z.string()).optional() })

/** One model installed in Ollama. */
export interface OllamaModel {
  /** The id requests name, tag included (`gemma4:31b`). */
  readonly name: string
  /** Ollama's parameter-count label (`31B`), when it reports one. */
  readonly parameterSize: string | null
}

/** What a look at the local Ollama server found. */
export type OllamaModels =
  | { readonly kind: 'unreachable' }
  | { readonly kind: 'ok'; readonly models: readonly OllamaModel[] }

/** Optional cancellation and a test transport. */
export interface ListOllamaModelsOptions {
  signal?: AbortSignal | undefined
  fetchFn?: typeof fetch
}

/**
 * Whether `model` can write text (`POST /api/show` lists `completion` among
 * its capabilities). An embedding model can't, and every summary request to
 * it would fail. A server too old to report capabilities, or a look that
 * fails or runs out of time, counts as able: the list stays what Ollama has
 * installed.
 */
async function canComplete(
  model: string,
  fetchFn: typeof fetch,
  signal: AbortSignal,
  callerSignal: AbortSignal | undefined,
): Promise<boolean> {
  try {
    const response = await fetchFn(ollamaNativeUrl(OLLAMA_BASE_URL, 'show'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, verbose: false }),
      signal,
    })
    if (!response.ok) {
      await response.body?.cancel()
      return true
    }
    const parsed = showSchema.safeParse(await readBoundedJson(response, MAX_SHOW_BYTES))
    return !parsed.success || parsed.data.capabilities?.includes('completion') !== false
  } catch {
    callerSignal?.throwIfAborted()
    return true
  }
}

/**
 * The models installed in the Ollama server on this Mac that can write a
 * summary (`GET /api/tags`, then each model's capabilities), through the
 * loopback-only transport, sorted by name. Cloud models are left out: Ollama
 * runs them elsewhere, and on-device verification refuses them. So are
 * embedding models. `unreachable` covers a server that is not running and
 * one that does not answer like Ollama.
 */
export async function listOllamaModels(
  options: ListOllamaModelsOptions = {},
): Promise<OllamaModels> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS)
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout
  const fetchFn = options.fetchFn ?? onDeviceFetch
  let installed: z.infer<typeof tagsSchema>['models']
  try {
    const response = await fetchFn(ollamaNativeUrl(OLLAMA_BASE_URL, 'tags'), { signal })
    if (!response.ok) {
      await response.body?.cancel()
      return { kind: 'unreachable' }
    }
    const parsed = tagsSchema.safeParse(await readBoundedJson(response, MAX_TAGS_BYTES))
    if (!parsed.success) {
      return { kind: 'unreachable' }
    }
    installed = parsed.data.models
  } catch {
    options.signal?.throwIfAborted()
    return { kind: 'unreachable' }
  }
  const models: OllamaModel[] = []
  // One look at a time: the loopback transport holds a few requests at once.
  for (const model of installed) {
    if (isOllamaCloudModel(model.name) || model.remote_host?.trim() || model.remote_model?.trim()) {
      continue
    }
    if (await canComplete(model.name, fetchFn, signal, options.signal)) {
      models.push({ name: model.name, parameterSize: model.details?.parameter_size ?? null })
    }
  }
  options.signal?.throwIfAborted()
  return { kind: 'ok', models: models.sort((left, right) => left.name.localeCompare(right.name)) }
}
