import type { LanguageModel } from '@reflect/modules/ai'
import type { HttpService } from '../ports/http-service.ts'
import { isLoopbackHttpUrl } from '../privacy/loopback.ts'
import type { ModelTarget } from '../privacy/on-device.ts'
import type { AiProviderConfig } from '../settings/schema.ts'
import { anthropicDirectBrowserAccessHeaders } from './anthropic-headers.ts'
import { APP_REVIEW_STUB_KEY, createDemoModel } from './app-review-demo.ts'
import type { OnDeviceHttpService } from './on-device-http-service.ts'
import { OPENAI_COMPATIBLE_PROVIDER_ID } from './openai-compatible.ts'
import { OPENROUTER_BASE_URL, openRouterAttributionHeaders } from './openrouter.ts'

/**
 * Loads each provider SDK on first use, so no SDK is in the startup bundle.
 */
export interface AiSdkLoader {
  openai: () => Promise<typeof import('@reflect/modules/ai-sdk/openai')>
  anthropic: () => Promise<typeof import('@reflect/modules/ai-sdk/anthropic')>
  google: () => Promise<typeof import('@reflect/modules/ai-sdk/google')>
  openaiCompatible: () => Promise<typeof import('@reflect/modules/ai-sdk/openai-compatible')>
}

/**
 * An {@link AiSdkLoader} over dynamic imports.
 */
export function createLazyAiSdkLoader(): AiSdkLoader {
  return {
    openai: () => import('@reflect/modules/ai-sdk/openai'),
    anthropic: () => import('@reflect/modules/ai-sdk/anthropic'),
    google: () => import('@reflect/modules/ai-sdk/google'),
    openaiCompatible: () => import('@reflect/modules/ai-sdk/openai-compatible'),
  }
}

declare const targetModelBrand: unique symbol

/**
 * A language model bound to the {@link ModelTarget} it was built from, so a
 * sink that receives one also knows where it runs. Built only by
 * {@link LanguageModelService.createFor} (and its test double).
 */
export interface TargetModel<TTarget extends ModelTarget = ModelTarget> {
  readonly target: TTarget
  readonly model: LanguageModel
  readonly [targetModelBrand]: true
}

/**
 * Turns a configured BYOK entry and its key into a callable language model.
 */
export interface LanguageModelService {
  /**
   * Build the AI SDK model instance for a configured BYOK entry: the one place
   * provider ids map to SDK factories. Shared by the chat engine
   * (`ChatEngineService`) and one-shot calls like the link-capture page
   * description (`PageDescriberService`). The App Review demo key gets the
   * local demo model regardless of the configured provider, since the
   * reviewer may have picked any of them. An OpenAI-compatible endpoint on a
   * loopback host always goes through the on-device transport
   * (`OnDeviceHttpService`); every other call goes over the host's HTTP.
   */
  create(config: AiProviderConfig, apiKey: string): Promise<LanguageModel>
  /**
   * Build the model for `target` from `target.config` alone, never from a
   * config looked up separately, so an on-device target cannot be paired with
   * another entry; callers look the API key up by `target.config.id`.
   * On-device targets always use the on-device transport. Cloud targets use
   * the host's HTTP, except a loopback endpoint, which goes through the
   * on-device transport whatever its tier.
   */
  createFor<TTarget extends ModelTarget>(
    target: TTarget,
    apiKey: string,
  ): Promise<TargetModel<TTarget>>
}

export interface LanguageModelServiceDeps {
  readonly http: HttpService
  readonly onDeviceHttp: OnDeviceHttpService
  readonly sdk: AiSdkLoader
}

class LanguageModelServiceImpl implements LanguageModelService {
  readonly #deps: LanguageModelServiceDeps
  readonly #cloudFetch: typeof fetch
  readonly #onDeviceFetch: typeof fetch

  constructor(deps: LanguageModelServiceDeps) {
    this.#deps = deps
    this.#cloudFetch = (input, init) => deps.http.fetch(input, init)
    this.#onDeviceFetch = (input, init) => deps.onDeviceHttp.fetch(input, init)
  }

  async create(config: AiProviderConfig, apiKey: string): Promise<LanguageModel> {
    return await this.#build(config, apiKey, this.#cloudFetch)
  }

  async createFor<TTarget extends ModelTarget>(
    target: TTarget,
    apiKey: string,
  ): Promise<TargetModel<TTarget>> {
    const fetchFn = target.kind === 'on-device' ? this.#onDeviceFetch : this.#cloudFetch
    const model = await this.#build(target.config, apiKey, fetchFn)
    // The brand has no runtime representation, so this assertion is the whole
    // binding; the guarantee is that the model came from target.config.
    return Object.freeze({ target, model }) as TargetModel<TTarget>
  }

  async #build(
    config: AiProviderConfig,
    apiKey: string,
    fetchFn: typeof fetch,
  ): Promise<LanguageModel> {
    const { sdk } = this.#deps
    if (apiKey === APP_REVIEW_STUB_KEY) {
      return createDemoModel()
    }
    switch (config.provider) {
      case 'openai': {
        const { createOpenAI } = await sdk.openai()
        return createOpenAI({ apiKey, fetch: fetchFn })(config.model)
      }
      case 'anthropic': {
        const { createAnthropic } = await sdk.anthropic()
        return createAnthropic({
          apiKey,
          fetch: fetchFn,
          headers: anthropicDirectBrowserAccessHeaders(),
        })(config.model)
      }
      case 'google': {
        const { createGoogle } = await sdk.google()
        return createGoogle({ apiKey, fetch: fetchFn })(config.model)
      }
      case 'openrouter': {
        const { createOpenAI } = await sdk.openai()
        return createOpenAI({
          apiKey,
          fetch: fetchFn,
          baseURL: OPENROUTER_BASE_URL,
          headers: openRouterAttributionHeaders(),
          name: 'openrouter',
        }).chat(config.model)
      }
      case 'openai-compatible': {
        const { createOpenAICompatible } = await sdk.openaiCompatible()
        return createOpenAICompatible({
          name: OPENAI_COMPATIBLE_PROVIDER_ID,
          baseURL: config.baseUrl,
          // A server on this Mac is reached only through the hardened
          // loopback transport, whatever fetch the caller's tier picked.
          fetch: isLoopbackHttpUrl(config.baseUrl) ? this.#onDeviceFetch : fetchFn,
          includeUsage: true,
          ...(apiKey.trim() === '' ? {} : { apiKey }),
        }).chatModel(config.model)
      }
    }
  }
}

export function createLanguageModelService(deps: LanguageModelServiceDeps): LanguageModelService {
  return new LanguageModelServiceImpl(deps)
}
