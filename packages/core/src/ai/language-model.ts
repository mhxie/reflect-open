import type { LanguageModel } from '@reflect/modules/ai'
import { isLoopbackHttpUrl } from '../privacy/loopback.ts'
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
