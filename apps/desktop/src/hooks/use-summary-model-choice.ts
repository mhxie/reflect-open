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
  /** Summarize in the cloud with `choice`; another provider entry asks for the go-ahead again. */
  chooseCloud: (choice: AiSummariesModel) => void
  /** Agree to send public notes to `choice`, pinning it. */
  startCloud: (choice: AiSummariesModel) => void
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
    chooseCloud: (choice) =>
      updateSettingsWith((current) => ({
        aiSummariesCloudModel: choice,
        aiSummariesCloudConfirmed:
          current.aiSummariesCloudConfirmed &&
          current.aiSummariesCloudModel?.configId === choice.configId,
      })),
    startCloud: (choice) =>
      updateSettings({ aiSummariesCloudModel: choice, aiSummariesCloudConfirmed: true }),
  }
}
