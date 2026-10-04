import type { LanguageModel } from '@reflect/modules/ai'
import { isLoopbackHttpUrl } from '../privacy/loopback.ts'
import type { ModelTarget } from '../privacy/on-device.ts'
import type { AiProviderConfig } from '../settings/schema.ts'
import { anthropicDirectBrowserAccessHeaders } from './anthropic-headers.ts'
import { APP_REVIEW_STUB_KEY, createDemoModel } from './app-review-demo.ts'
import { onDeviceFetch } from './on-device-fetch.ts'
import { OPENAI_COMPATIBLE_PROVIDER_ID } from './openai-compatible.ts'
import { OPENROUTER_BASE_URL, openRouterAttributionHeaders } from './openrouter.ts'

/**
 * Build the AI SDK model instance for a configured BYOK entry — the one place
 * provider ids map to SDK factories. Shared by the chat engine
 * (`chat/stream-chat`) and one-shot calls like the link-capture page
 * description (`describe-page`). An OpenAI-compatible endpoint on a loopback
 * host always goes through {@link onDeviceFetch}; `fetchFn` carries every
 * other call.
 */
export async function languageModel(
  config: AiProviderConfig,
  apiKey: string,
  fetchFn: typeof fetch,
): Promise<LanguageModel> {
  // App Review demo mode: a local model regardless of the configured
  // provider, since the reviewer may have picked any of them.
  if (apiKey === APP_REVIEW_STUB_KEY) {
    return createDemoModel()
  }
  switch (config.provider) {
    case 'openai': {
      const { createOpenAI } = await import('@reflect/modules/ai-sdk/openai')
      return createOpenAI({ apiKey, fetch: fetchFn })(config.model)
    }
    case 'anthropic': {
      const { createAnthropic } = await import('@reflect/modules/ai-sdk/anthropic')
      return createAnthropic({
        apiKey,
        fetch: fetchFn,
        headers: anthropicDirectBrowserAccessHeaders(),
      })(config.model)
    }
    case 'google': {
      const { createGoogle } = await import('@reflect/modules/ai-sdk/google')
      return createGoogle({ apiKey, fetch: fetchFn })(config.model)
    }
    case 'openrouter': {
      const { createOpenAI } = await import('@reflect/modules/ai-sdk/openai')
      return createOpenAI({
        apiKey,
        fetch: fetchFn,
        baseURL: OPENROUTER_BASE_URL,
        headers: openRouterAttributionHeaders(),
        name: 'openrouter',
      }).chat(config.model)
    }
    case 'openai-compatible': {
      const { createOpenAICompatible } = await import('@reflect/modules/ai-sdk/openai-compatible')
      return createOpenAICompatible({
        name: OPENAI_COMPATIBLE_PROVIDER_ID,
        baseURL: config.baseUrl,
        // A server on this Mac is reached only through the hardened
        // loopback transport, whatever fetch the caller passed.
        fetch: isLoopbackHttpUrl(config.baseUrl) ? onDeviceFetch : fetchFn,
        includeUsage: true,
        ...(apiKey.trim() === '' ? {} : { apiKey }),
      }).chatModel(config.model)
    }
  }
}

declare const targetModelBrand: unique symbol

/**
 * A language model bound to the {@link ModelTarget} it was built from, so a
 * sink that receives one also knows where it runs. Built only by
 * {@link languageModelFor}, and by `testing/target-model.ts` for tests.
 */
export interface TargetModel<TTarget extends ModelTarget = ModelTarget> {
  readonly target: TTarget
  readonly model: LanguageModel
  readonly [targetModelBrand]: true
}

/**
 * Build the model for `target` from `target.config` alone, never from a
 * config looked up separately, so an on-device target cannot be paired with
 * another entry; callers look the API key up by `target.config.id`.
 * On-device targets always use {@link onDeviceFetch}. Cloud targets use
 * `cloudFetch`, except a loopback endpoint, which {@link languageModel}
 * sends through the loopback transport whatever its tier.
 */
export async function languageModelFor<TTarget extends ModelTarget>(
  target: TTarget,
  apiKey: string,
  cloudFetch: typeof fetch,
): Promise<TargetModel<TTarget>> {
  const fetchFn = target.kind === 'on-device' ? onDeviceFetch : cloudFetch
  const model = await languageModel(target.config, apiKey, fetchFn)
  // The brand has no runtime representation, so this assertion is the whole
  // binding; the guarantee is that the model came from target.config.
  return Object.freeze({ target, model }) as TargetModel<TTarget>
}
