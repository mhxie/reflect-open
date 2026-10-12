import type { ReactElement } from 'react'
import { AI_SUMMARY_MODES, aiSummariesSchema, type AiSummaryMode } from '@reflect/core'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select.tsx'
import { useSettings } from '@/providers/settings-provider.tsx'
import { CloudSummaryModelPicker } from './cloud-summary-model-picker.tsx'
import { SettingsField } from './field.tsx'
import { LocalSummaryModelPicker } from './local-summary-model-picker.tsx'

const MODE_LABELS: Readonly<Record<AiSummaryMode, string>> = {
  local: 'On this Mac',
  cloud: 'Cloud provider',
  off: 'Off · show the opening text',
}

const MODE_DESCRIPTIONS: Readonly<Record<AiSummaryMode, string>> = {
  local:
    'Long notes are summarized by a model running on this Mac, private notes included. Nothing leaves this Mac.',
  cloud:
    'Long notes are summarized by the cloud model you choose. Private notes are never sent and keep their opening text.',
  off: 'Long notes show their opening text in the All Notes list.',
}

const MODE_OPTIONS = AI_SUMMARY_MODES.map((value) => ({ value, label: MODE_LABELS[value] }))

/**
 * Settings → All Notes → AI summaries: which engine, and which model, writes
 * the one-sentence summary a long note shows in the All Notes list (its
 * `aiSummary` frontmatter). The cloud engine sends nothing until the user
 * agrees to the model it names.
 */
export function AiSummariesField(): ReactElement {
  const { settings, updateSettings } = useSettings()
  const mode = settings.aiSummaries

  return (
    <SettingsField legend="AI summaries" description={MODE_DESCRIPTIONS[mode]}>
      <div className="mt-3 max-w-md">
        <Select
          value={mode}
          items={MODE_OPTIONS}
          onValueChange={(value) => updateSettings({ aiSummaries: aiSummariesSchema.parse(value) })}
        >
          <SelectTrigger aria-label="AI summaries">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MODE_OPTIONS.map(({ value, label }) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {mode === 'local' ? <LocalSummaryModelPicker /> : null}
      {mode === 'cloud' ? <CloudSummaryModelPicker /> : null}
    </SettingsField>
  )
}
