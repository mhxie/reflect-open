import type { ReactElement } from 'react'
import {
  aiProvider,
  cloudSummaryConfig,
  resolveOnDeviceTarget,
  smallModelConfig,
  type AiProviderConfig,
} from '@reflect/core'
import { Button } from '@/components/ui/button.tsx'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select.tsx'
import { useSummaryModelChoice } from '@/hooks/use-summary-model-choice.ts'
import { useSettings } from '@/providers/settings-provider.tsx'
import { ModelCombobox } from './model-combobox.tsx'

/** How a provider entry reads in the picker: its provider, then what tells two apart. */
function entryLabel(config: AiProviderConfig): string {
  const name = aiProvider(config.provider).label
  if (config.provider === 'openai-compatible') {
    return `${name} · ${new URL(config.baseUrl).host}`
  }
  return config.keyHint === '' ? name : `${name} · ·····${config.keyHint}`
}

/** The model a newly chosen entry starts on: its small model, else its own. */
function startingModel(config: AiProviderConfig): string {
  return smallModelConfig(config)?.model ?? config.model
}

/**
 * Settings → All Notes → AI summaries, Cloud provider: which configured
 * provider and model summarize, and the one-time go-ahead. Only entries that
 * don't run on this Mac are offered. Nothing is sent until the user starts;
 * choosing another provider entry asks again.
 */
export function CloudSummaryModelPicker(): ReactElement {
  const { settings } = useSettings()
  const { chooseCloud, startCloud } = useSummaryModelChoice()
  const choice = settings.aiSummariesCloudModel
  const config = cloudSummaryConfig(
    { providers: settings.aiProviders, defaultProviderId: settings.defaultAiProviderId },
    choice,
  )
  const entries = settings.aiProviders.filter((entry) => resolveOnDeviceTarget(entry) === null)

  if (entries.length === 0) {
    return (
      <p className="mt-2 text-xs text-text-muted">
        Add an OpenAI, Anthropic, Google, or OpenAI-compatible provider in AI providers to start
        summarizing.
      </p>
    )
  }

  const selected = config === null || config === 'on-device' ? null : config
  const agreed = settings.aiSummariesCloudConfirmed && choice !== null
  let hint: string | null = null
  if (config === 'on-device') {
    hint = 'Your default AI provider runs on this Mac. Choose a cloud provider, or On this Mac.'
  } else if (config === null) {
    hint =
      choice === null
        ? 'Choose a provider to start summarizing.'
        : 'The provider chosen for summaries was removed. Choose another.'
  }

  return (
    <>
      <div className="mt-3 flex max-w-md flex-col gap-2">
        <Select
          value={selected?.id ?? ''}
          items={entries.map((entry) => ({ value: entry.id, label: entryLabel(entry) }))}
          onValueChange={(value) => {
            const entry = entries.find((candidate) => candidate.id === value)
            if (entry !== undefined) {
              chooseCloud({ configId: entry.id, modelId: startingModel(entry) })
            }
          }}
        >
          <SelectTrigger aria-label="Summary provider">
            <SelectValue placeholder="Choose a provider" />
          </SelectTrigger>
          <SelectContent>
            {entries.map((entry) => (
              <SelectItem key={entry.id} value={entry.id}>
                {entryLabel(entry)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {selected === null ? null : (
          <ModelCombobox
            value={selected.model}
            provider={selected.provider}
            models={aiProvider(selected.provider).models}
            onChange={(modelId) => chooseCloud({ configId: selected.id, modelId })}
            ariaLabel="Summary model"
          />
        )}
      </div>
      {hint === null ? null : <p className="mt-2 text-xs text-text-muted">{hint}</p>}
      {selected === null || agreed ? null : (
        <div className="mt-3 flex flex-col items-start">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => startCloud({ configId: selected.id, modelId: selected.model })}
            className="text-text-secondary"
          >
            Start summarizing
          </Button>
          <p className="mt-2 text-xs text-text-muted">
            Nothing is sent until you start. Existing long notes are summarized first.
          </p>
        </div>
      )}
    </>
  )
}
