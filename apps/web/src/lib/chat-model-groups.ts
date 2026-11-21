import {
  aiProvider,
  isOnDeviceOption,
  type AiProviderConfig,
  type AiProvidersState,
  type ChatModelOption,
} from '@reflect/core'

/** One configured provider's models, shaped for a picker. */
export interface ModelOptionGroup {
  configId: string
  /** Provider label, key-hint-qualified when the provider is configured twice. */
  label: string
  /** The group's models, each with its picker value (index into the options). */
  options: Array<{ option: ChatModelOption; value: string }>
}

/** Appended to the label of a model the user attested runs on this Mac. */
export const ON_DEVICE_OPTION_SUFFIX = ' · On this Mac'

function providerQualifier(provider: AiProviderConfig): string {
  if (provider.provider === 'openai-compatible') {
    return provider.baseUrl
  }
  return provider.keyHint === '' ? '' : `·····${provider.keyHint}`
}

/**
 * The flat option list regrouped per configured provider for rendering
 * (options arrive consecutively per entry). Values are list indexes — model
 * ids alone can collide across providers. A model whose pick resolves
 * on-device (its endpoint and model are attested) is labeled "· On this
 * Mac". Shared by desktop's composer `Select` and the mobile model sheet.
 */
export function groupModelOptions(
  options: ChatModelOption[],
  providers: AiProviderConfig[],
): ModelOptionGroup[] {
  const state: AiProvidersState = { providers, defaultProviderId: null }
  const groups: ModelOptionGroup[] = []
  for (const [index, option] of options.entries()) {
    const labeled = isOnDeviceOption(state, option)
      ? { ...option, label: `${option.label}${ON_DEVICE_OPTION_SUFFIX}` }
      : option
    const item = { option: labeled, value: String(index) }
    const last = groups.at(-1)
    if (last?.configId === option.configId) {
      last.options.push(item)
      continue
    }
    const providerLabel = aiProvider(option.provider).label
    const duplicated =
      providers.filter((provider) => provider.provider === option.provider).length > 1
    const configured = providers.find((provider) => provider.id === option.configId) ?? null
    const qualifier = configured === null ? '' : providerQualifier(configured)
    groups.push({
      configId: option.configId,
      label: duplicated && qualifier !== '' ? `${providerLabel} · ${qualifier}` : providerLabel,
      options: [item],
    })
  }
  return groups
}
