import type { ReactElement } from 'react'
import { transcriptionLanguagesSchema } from '@reflect/core'
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

const LANGUAGE_OPTIONS: LanguageOption[] = [
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

/**
 * The spoken languages, shared by the cloud and on-device engines: none
 * detects any language, one is always used, and several limit detection to
 * themselves.
 */
export function TranscriptionLanguagesField(): ReactElement {
  const { settings, updateSettingsWith } = useSettings()
  const selected = settings.transcriptionLanguages
  // A code stored by hand (or by a newer app) stays selectable as itself.
  const items = [
    ...LANGUAGE_OPTIONS,
    ...selected
      .filter((code) => !LANGUAGE_OPTIONS.some((option) => option.value === code))
      .map((code) => ({ value: code, label: code })),
  ]
  const labelOf = (code: string): string => items.find((item) => item.value === code)?.label ?? code

  const pick = (next: string[]): void => {
    const added = next.filter((code) => !selected.includes(code))
    const removed = selected.filter((code) => !next.includes(code))
    // Applied to the loaded settings, not this render's: a pick made while
    // they still load must not replace the saved list.
    updateSettingsWith((current) => ({
      transcriptionLanguages: transcriptionLanguagesSchema.parse([
        ...current.transcriptionLanguages.filter((code) => !removed.includes(code)),
        ...added,
      ]),
    }))
  }

  return (
    <SettingsField
      legend="Spoken languages"
      description={
        settings.transcriptionEngine === 'cloud'
          ? 'Transcripts stay in the languages you pick (OpenAI enforces only a single pick). Pick none to detect any language.'
          : 'Transcripts stay in the languages you pick. Pick none to detect any language.'
      }
    >
      <div className="mt-3">
        <Select multiple value={selected} items={items} onValueChange={pick}>
          <SelectTrigger aria-label="Spoken languages" className="w-56">
            <SelectValue>
              {selected.length === 0 ? 'Any language' : selected.map(labelOf).join(', ')}
            </SelectValue>
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
