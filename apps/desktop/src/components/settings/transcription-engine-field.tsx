import type { ReactElement } from 'react'
import type { TranscriptionEngine } from '@reflect/core'
import { cn } from '@/lib/utils.ts'
import { useSettings } from '@/providers/settings-provider.tsx'
import { SettingsField } from './field.tsx'
import { SettingsOptionCard } from './option-card.tsx'

interface EngineOption {
  value: TranscriptionEngine
  label: string
  description: string
}

const ENGINE_OPTIONS: EngineOption[] = [
  {
    value: 'cloud',
    label: 'Cloud provider',
    description: 'Your OpenAI or Gemini key',
  },
  {
    value: 'local',
    label: 'On this Mac',
    description: 'Whisper, offline',
  },
]

/** Where audio memos are transcribed (macOS offers the on-device engine). */
export function TranscriptionEngineField(): ReactElement {
  const { settings, updateSettings } = useSettings()

  return (
    <SettingsField
      legend="Transcription engine"
      description="On this Mac, nothing leaves the device: no recording or transcript is sent anywhere, and the model downloads once. Its memos keep the raw transcript, titled from their first words."
    >
      <div className="mt-3 @container">
        <div className="grid grid-cols-1 gap-2 @xl:grid-cols-2">
          {ENGINE_OPTIONS.map((option) => {
            const selected = settings.transcriptionEngine === option.value
            return (
              <SettingsOptionCard
                key={option.value}
                selected={selected}
                className="items-start justify-between gap-3 px-3 py-2.5"
              >
                <span className="min-w-0 flex-1">
                  <span
                    className={cn('block text-sm font-medium', selected && 'text-accent-soft-text')}
                  >
                    {option.label}
                  </span>
                  <span className="mt-0.5 block text-xs text-text-muted">{option.description}</span>
                </span>
                <input
                  type="radio"
                  name="transcription-engine"
                  value={option.value}
                  checked={selected}
                  onChange={() => updateSettings({ transcriptionEngine: option.value })}
                  className="mt-0.5 shrink-0 accent-accent"
                />
              </SettingsOptionCard>
            )
          })}
        </div>
      </div>
    </SettingsField>
  )
}
