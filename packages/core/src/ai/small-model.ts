import type { AiProvidersState } from './provider-config.ts'
import type { AiProviderConfig } from '../settings/schema.ts'

/**
 * The small, cheap model each provider offers for background enrichment
 * (audio memo titles and formatting, note summaries): short one-shot calls
 * where the chat model would be wasted spend.
 */

const OPENAI_SMALL_MODEL = 'gpt-5.4-nano'
const ANTHROPIC_SMALL_MODEL = 'claude-haiku-4-5'
const GOOGLE_SMALL_MODEL = 'gemini-3.1-flash-lite'

/**
 * Replace a configured model with the provider's fixed small model. OpenRouter
 * has none (`openrouter/auto` is not a small-model guarantee), so it yields
 * `null`; OpenAI-compatible entries keep the model the user configured for
 * that endpoint.
 */
export function smallModelConfig(config: AiProviderConfig): AiProviderConfig | null {
  switch (config.provider) {
    case 'openai':
      return { ...config, model: OPENAI_SMALL_MODEL }
    case 'anthropic':
      return { ...config, model: ANTHROPIC_SMALL_MODEL }
    case 'google':
      return { ...config, model: GOOGLE_SMALL_MODEL }
    case 'openrouter':
      return null
    case 'openai-compatible':
      return config
  }
}

/**
 * Pick the small-model provider for background enrichment. The user's default
 * provider wins when it has a small model ({@link smallModelConfig});
 * otherwise the first configured provider that does.
 */
export function pickSmallModelConfig(state: AiProvidersState): AiProviderConfig | null {
  const preferred = state.providers.find((provider) => provider.id === state.defaultProviderId)
  const ordered =
    preferred === undefined
      ? state.providers
      : [preferred, ...state.providers.filter((provider) => provider.id !== preferred.id)]
  for (const provider of ordered) {
    const config = smallModelConfig(provider)
    if (config !== null) {
      return config
    }
  }
  return null
}
