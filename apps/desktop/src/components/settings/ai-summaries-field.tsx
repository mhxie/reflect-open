import type { ReactElement } from 'react'
import {
  AI_SUMMARY_MODES,
  aiSummariesSchema,
  pickOnDeviceProvider,
  type AiSummaryMode,
} from '@reflect/core'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select.tsx'
import { useSettings } from '@/providers/settings-provider.tsx'
import { SettingsField } from './field.tsx'

const MODE_LABELS: Readonly<Record<AiSummaryMode, string>> = {
  off: 'Off · show the opening text',
  local: 'On-device model only',
  'local-and-cloud': 'On-device model, then AI provider',
}

const MODE_DESCRIPTIONS: Readonly<Record<AiSummaryMode, string>> = {
  off: 'Long notes show their opening text in the All Notes list.',
  local:
    'Long notes are summarized by your on-device model, private notes included. Nothing leaves this Mac.',
  'local-and-cloud':
    'Long notes are summarized by your on-device model. When none answers, public notes go to your AI provider; private notes are never sent.',
}

const MODE_OPTIONS = AI_SUMMARY_MODES.map((value) => ({ value, label: MODE_LABELS[value] }))

/**
 * Settings → All Notes → AI summaries: who may write the one-sentence summary
 * a long note shows in the All Notes list (its `aiSummary` frontmatter).
 */
export function AiSummariesField(): ReactElement {
  const { settings, updateSettings } = useSettings()
  const hasOnDeviceModel =
    pickOnDeviceProvider({
      providers: settings.aiProviders,
      defaultProviderId: settings.defaultAiProviderId,
    }) !== null
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
      {mode !== 'off' && !hasOnDeviceModel ? (
        <p className="mt-2 text-xs text-text-muted">
          {mode === 'local'
            ? 'Add an on-device model in AI providers to start summarizing.'
            : 'No on-device model is set up, so public notes are summarized by your AI provider.'}
        </p>
      ) : null}
    </SettingsField>
  )
}
