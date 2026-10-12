import {
  OLLAMA_BASE_URL,
  withOnDeviceModel,
  type AiProviderConfig,
  type AiSummariesModel,
  type OnDeviceServerKind,
} from '@reflect/core'
import { useSettings } from '@/providers/settings-provider.tsx'

/** The writes behind the AI summaries model picker (Settings → All Notes). */
export interface SummaryModelChoice {
  /** Summarize on this Mac with `config`, an entry attested for its model. */
  chooseLocal: (config: AiProviderConfig) => void
  /**
   * Summarize on this Mac with `model` from Ollama, once the user confirmed
   * that it runs here: an entry already attested for it is reused, else one
   * is attested or added. No other entry changes.
   */
  chooseOllamaModel: (model: string, server: OnDeviceServerKind) => void
  /** Summarize in the cloud with `choice`; anything but the agreed model asks again. */
  chooseCloud: (choice: AiSummariesModel) => void
  /** Agree to send public notes to exactly `choice`, and summarize with it. */
  startCloud: (choice: AiSummariesModel) => void
}

/** The settings a cloud go-ahead writes: the model it names, chosen and agreed to. */
export function cloudGoAhead(choice: AiSummariesModel): {
  aiSummariesCloudModel: AiSummariesModel
  aiSummariesCloudConsent: AiSummariesModel
} {
  return { aiSummariesCloudModel: choice, aiSummariesCloudConsent: choice }
}

/**
 * Settings writes for choosing the model AI summaries use. Each is one
 * update built from the settings as they are when it applies.
 */
export function useSummaryModelChoice(): SummaryModelChoice {
  const { updateSettings, updateSettingsWith } = useSettings()
  return {
    chooseLocal: (config) =>
      updateSettings({ aiSummariesLocalModel: { configId: config.id, modelId: config.model } }),
    chooseOllamaModel: (model, server) =>
      updateSettingsWith((current) => {
        const { state, id } = withOnDeviceModel(
          { providers: current.aiProviders, defaultProviderId: current.defaultAiProviderId },
          OLLAMA_BASE_URL,
          model,
          server,
          () => crypto.randomUUID(),
        )
        return {
          aiProviders: state.providers,
          defaultAiProviderId: state.defaultProviderId,
          aiSummariesLocalModel: { configId: id, modelId: model },
        }
      }),
    chooseCloud: (choice) => updateSettings({ aiSummariesCloudModel: choice }),
    startCloud: (choice) => updateSettings(cloudGoAhead(choice)),
  }
}
