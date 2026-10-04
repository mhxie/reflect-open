import type { ReactElement } from 'react'
import { LOCAL_TRANSCRIPTION_MODELS } from '@reflect/core'
import { formatModelSize } from '@/lib/format-model-size.ts'
import { useLocalModelStatus } from '@/lib/use-local-model-status.ts'
import { cn } from '@/lib/utils.ts'
import { useSettings } from '@/providers/settings-provider.tsx'
import { SettingsField } from './field.tsx'
import { LocalModelActions } from './local-model-actions.tsx'
import { SettingsOptionCard } from './option-card.tsx'
import { SettingsSwitchField } from './switch-field.tsx'

/** The on-device engine's model choice, its download, and update checks. */
export function LocalModelField(): ReactElement {
  const { settings, updateSettings } = useSettings()
  const model = settings.localTranscriptionModel
  const status = useLocalModelStatus(model, true)

  return (
    <>
      <SettingsField
        legend="On-device model"
        description="Larger models transcribe more accurately. Every model runs on this Mac's GPU."
      >
        <div className="mt-3 @container">
          <div className="grid grid-cols-1 gap-2 @xl:grid-cols-2">
            {LOCAL_TRANSCRIPTION_MODELS.map((option) => {
              const selected = model === option.id
              return (
                <SettingsOptionCard
                  key={option.id}
                  selected={selected}
                  className="items-start justify-between gap-3 px-3 py-2.5"
                >
                  <span className="min-w-0 flex-1">
                    <span
                      className={cn(
                        'block text-sm font-medium',
                        selected && 'text-accent-soft-text',
                      )}
                    >
                      {option.label}
                    </span>
                    <span className="mt-0.5 block text-xs text-text-muted">
                      {option.description} · {formatModelSize(option.sizeBytes)}
                    </span>
                  </span>
                  <input
                    type="radio"
                    name="local-transcription-model"
                    value={option.id}
                    checked={selected}
                    onChange={() => updateSettings({ localTranscriptionModel: option.id })}
                    className="mt-0.5 shrink-0 accent-accent"
                  />
                </SettingsOptionCard>
              )
            })}
          </div>
        </div>
        <div className="mt-3">
          <LocalModelActions model={model} status={status} />
        </div>
      </SettingsField>
      <SettingsSwitchField
        legend="Check for model updates"
        description="Look for newer weights once a day. Updates are offered, never installed on their own."
        checked={settings.localTranscriptionUpdateChecks}
        onCheckedChange={(localTranscriptionUpdateChecks) =>
          updateSettings({ localTranscriptionUpdateChecks })
        }
      />
    </>
  )
}
