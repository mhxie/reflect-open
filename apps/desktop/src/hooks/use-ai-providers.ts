import {
  defaultAiProvider,
  type AiProviderCapabilities,
  type AiProviderConfig,
  type AiProvidersState,
  type NewAiProvider,
  type OnDeviceServerKind,
} from '@reflect/core'
import { useSelector } from '@/lib/use-store.ts'
import { useCoreServices } from '@/services/services-provider.tsx'

interface UseAiProvidersValue {
  providers: AiProviderConfig[]
  /**
   * The entry AI features use by default (null only when the list is empty).
   */
  defaultProvider: AiProviderConfig | null
  /**
   * Store the key in the keychain, then add the settings entry. Rejects (and
   * adds nothing) if the keychain write fails — so an entry can never point
   * at a key that was never stored — or if the settings store could not be
   * read this session, so a key can never be stored for an entry that won't
   * survive a restart.
   */
  addProvider: (draft: NewAiProvider) => Promise<void>
  /**
   * Delete the key from the keychain, then drop the settings entry.
   */
  removeProvider: (id: string) => Promise<void>
  /**
   * Make the entry with `id` the app-wide default.
   */
  makeDefault: (id: string) => void
  /**
   * Change the default model used by the configured provider entry. An
   * on-device attestation for another model is dropped.
   */
  setDefaultModel: (id: string, model: string) => void
  /**
   * Attest that an OpenAI-compatible entry runs its model on this Mac, for
   * exactly its current base URL and model, or withdraw that. Attesting an
   * entry whose base URL is not a loopback host changes nothing.
   */
  setOnDevice: (id: string, attest: boolean, server?: OnDeviceServerKind) => void
  /**
   * Change what an OpenAI-compatible entry declares about its model.
   */
  setCapabilities: (id: string, capabilities: AiProviderCapabilities) => void
}

function selectProviders(state: AiProvidersState): AiProviderConfig[] {
  return state.providers
}

/**
 * The configured-AI-providers surface (Plan 10), over the `AiProviderConfigService`.
 */
export function useAiProviders(): UseAiProvidersValue {
  const { aiProviderConfig: service } = useCoreServices()
  const providers = useSelector(service, selectProviders)
  const defaultProvider = useSelector(service, defaultAiProvider)
  return {
    providers,
    defaultProvider,
    addProvider: (draft) => service.add(draft),
    removeProvider: (id) => service.remove(id),
    makeDefault: (id) => service.makeDefault(id),
    setDefaultModel: (id, model) => service.setDefaultModel(id, model),
    setOnDevice: (id, attest, server) => service.setOnDevice(id, attest, server),
    setCapabilities: (id, capabilities) => service.setCapabilities(id, capabilities),
  }
}
