import type { ReactElement } from 'react'
import { transcriptionLanguageSchema } from '@reflect/core'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select.tsx'
import { useSettings } from '@/providers/settings-provider.tsx'
import { SettingsField } from './field.tsx'

interface LanguageOption {
  value: string
  label: string
}

/** `auto` stands in for the stored empty string (detect per recording). */
const AUTO = 'auto'

const LANGUAGE_OPTIONS: LanguageOption[] = [
  { value: AUTO, label: 'Detect automatically' },
  { value: 'en', label: 'English' },
  { value: 'zh', label: 'Chinese' },
  { value: 'yue', label: 'Cantonese' },
  { value: 'ja', label: 'Japanese' },
  { value: 'ko', label: 'Korean' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
  { value: 'pt', label: 'Portuguese' },
  { value: 'it', label: 'Italian' },
  { value: 'ru', label: 'Russian' },
  { value: 'hi', label: 'Hindi' },
]

/** The spoken language hint, shared by the cloud and on-device engines. */
export function TranscriptionLanguageField(): ReactElement {
  const { settings, updateSettings } = useSettings()
  const current = settings.transcriptionLanguage === '' ? AUTO : settings.transcriptionLanguage
  // A code stored by hand (or by a newer app) stays selectable as itself.
  const items = LANGUAGE_OPTIONS.some((option) => option.value === current)
    ? LANGUAGE_OPTIONS
    : [...LANGUAGE_OPTIONS, { value: current, label: current }]

  return (
    <SettingsField
      legend="Spoken language"
      description="Automatic detection suits memos that mix languages; naming one helps short or accented recordings."
    >
      <div className="mt-3">
        <Select
          value={current}
          items={items}
          onValueChange={(value) =>
            updateSettings({
              transcriptionLanguage: transcriptionLanguageSchema.parse(value === AUTO ? '' : value),
            })
          }
        >
          <SelectTrigger aria-label="Spoken language" className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {items.map(({ value, label }) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
    </SettingsField>
  )
}
