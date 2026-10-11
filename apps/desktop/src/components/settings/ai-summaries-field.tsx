import type { ReactElement } from 'react'
import {
  AI_SUMMARY_MODES,
  aiSummariesSchema,
  cloudSummaryConfig,
  pickOnDeviceProvider,
  type AiProvidersState,
  type AiSummaryMode,
} from '@reflect/core'
import { Button } from '@/components/ui/button.tsx'
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
    'Long notes are summarized by an on-device model you add in AI providers, private notes included. Nothing leaves this Mac.',
  off: 'Long notes show their opening text in the All Notes list.',
}

const MODE_OPTIONS = AI_SUMMARY_MODES.map((value) => ({ value, label: MODE_LABELS[value] }))

/** Why `mode` can't summarize yet, or `null` when it has a model. */
function setupHint(mode: AiSummaryMode, providers: AiProvidersState): string | null {
  if (mode === 'off') {
    return null
  }
  if (mode === 'local') {
    return pickOnDeviceProvider(providers) === null
      ? 'Add an on-device model in AI providers to start summarizing.'
      : null
  }
  const config = cloudSummaryConfig(providers)
  if (config === null) {
    return 'Add an OpenAI, Anthropic, Google, or OpenAI-compatible provider in AI providers to start summarizing.'
  }
  return config === 'on-device'
    ? 'Your default AI provider runs on this Mac. Choose On this Mac, or make a cloud provider the default.'
    : null
}

/**
 * Settings → All Notes → AI summaries: which engine writes the one-sentence
 * summary a long note shows in the All Notes list (its `aiSummary`
 * frontmatter). Until the user agrees once, the cloud engine sends nothing;
 * Start here answers the same ask as the prompt the summary pass raises.
 */
export function AiSummariesField(): ReactElement {
  const { settings, updateSettings } = useSettings()
  const mode = settings.aiSummaries
  const hint = setupHint(mode, {
    providers: settings.aiProviders,
    defaultProviderId: settings.defaultAiProviderId,
  })
  const awaitingConsent = mode === 'cloud' && hint === null && !settings.aiSummariesCloudConfirmed

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
      {hint === null ? null : <p className="mt-2 text-xs text-text-muted">{hint}</p>}
      {awaitingConsent ? (
        <div className="mt-3 flex flex-col items-start">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => updateSettings({ aiSummariesCloudConfirmed: true })}
            className="text-text-secondary"
          >
            Start summarizing
          </Button>
          <p className="mt-2 text-xs text-text-muted">
            Nothing is sent until you start. Existing long notes are summarized first.
          </p>
        </div>
      ) : null}
    </SettingsField>
  )
}
