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

/** Optional cancellation, another server address, and a test transport. */
export interface ListOllamaModelsOptions {
  baseUrl?: string
  signal?: AbortSignal | undefined
  fetchFn?: typeof fetch
}

/**
 * The models installed in the Ollama server on this Mac (`GET /api/tags`),
 * through the loopback-only transport, sorted by name. Cloud models are left
 * out: Ollama runs them elsewhere, and on-device verification refuses them.
 * `unreachable` covers a server that is not running and one that does not
 * answer like Ollama.
 */
export async function listOllamaModels(
  options: ListOllamaModelsOptions = {},
): Promise<OllamaModels> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS)
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout
  const fetchFn = options.fetchFn ?? onDeviceFetch
  try {
    const response = await fetchFn(ollamaNativeUrl(options.baseUrl ?? OLLAMA_BASE_URL, 'tags'), {
      signal,
    })
    if (!response.ok) {
      await response.body?.cancel()
      return { kind: 'unreachable' }
    }
    const parsed = tagsSchema.safeParse(await readBoundedJson(response, MAX_TAGS_BYTES))
    if (!parsed.success) {
      return { kind: 'unreachable' }
    }
    const models = parsed.data.models
      .filter(
        (model) =>
          !isOllamaCloudModel(model.name) &&
          !model.remote_host?.trim() &&
          !model.remote_model?.trim(),
      )
      .map((model) => ({ name: model.name, parameterSize: model.details?.parameter_size ?? null }))
      .sort((left, right) => left.name.localeCompare(right.name))
    return { kind: 'ok', models }
  } catch {
    options.signal?.throwIfAborted()
    return { kind: 'unreachable' }
  }
}
