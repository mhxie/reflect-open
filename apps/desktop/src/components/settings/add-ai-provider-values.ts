import type { AiProviderId, OnDeviceServerKind } from '@reflect/core'

/** The add-provider form's fields, which `AddAiProviderLocalFields` reads too. */
export interface AddAiProviderValues {
  provider: AiProviderId
  model: string
  baseUrl: string
  apiKey: string
  isDefault: boolean
  /** OpenAI-compatible only: attest the endpoint runs `model` on this Mac. */
  onDevice: boolean
  onDeviceServer: OnDeviceServerKind
  /** OpenAI-compatible only: the model accepts image input. */
  supportsImages: boolean
  /** OpenAI-compatible only: the context length as typed; blank for the server's default. */
  contextWindow: string
}
