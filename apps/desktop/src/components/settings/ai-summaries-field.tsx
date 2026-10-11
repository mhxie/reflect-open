import type { ReactElement } from 'react'
import {
  AI_SUMMARY_MODES,
  aiSummariesSchema,
  pickOnDeviceProvider,
  pickSmallModelConfig,
  resolveOnDeviceTarget,
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
  cloud: 'Cloud provider',
  local: 'On this Mac',
  off: 'Off · show the opening text',
}

const MODE_DESCRIPTIONS: Readonly<Record<AiSummaryMode, string>> = {
  cloud:
    'Long notes are summarized by your AI provider’s small model. Private notes are never sent and keep their opening text.',
  local:
    'Long notes are summarized by an on-device model from AI providers, private notes included. Nothing leaves this Mac.',
  off: 'Long notes show their opening text in the All Notes list.',
}

const MODE_OPTIONS = AI_SUMMARY_MODES.map((value) => ({ value, label: MODE_LABELS[value] }))

/**
 * Settings → All Notes → AI summaries: which engine writes the one-sentence
 * summary a long note shows in the All Notes list (its `aiSummary`
 * frontmatter). As for audio-memo transcription, the default is the AI
 * provider set up in Reflect; a model on this Mac is the opt-in.
 */
export function AiSummariesField(): ReactElement {
  const { settings, updateSettings } = useSettings()
  const providers = {
    providers: settings.aiProviders,
    defaultProviderId: settings.defaultAiProviderId,
  }
  const mode = settings.aiSummaries
  // The model each engine summarizes with, picked as the summary pass picks it.
  const cloudModel = pickSmallModelConfig(providers)
  const hasModel =
    mode === 'local'
      ? pickOnDeviceProvider(providers) !== null
      : cloudModel !== null && resolveOnDeviceTarget(cloudModel) === null

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
      {mode !== 'off' && !hasModel ? (
        <p className="mt-2 text-xs text-text-muted">
          {mode === 'local'
            ? 'Add an on-device model in AI providers to start summarizing.'
            : 'Add an OpenAI, Anthropic, or Google provider in AI providers to start summarizing.'}
        </p>
      ) : null}
    </SettingsField>
  )
}
