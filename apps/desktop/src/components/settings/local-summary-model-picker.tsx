import { useState, type ReactElement, type ReactNode } from 'react'
import {
  localSummaryTarget,
  normalizeOpenAICompatibleBaseUrl,
  OLLAMA_BASE_URL,
  resolveOnDeviceTarget,
  type AiProviderConfig,
  type OllamaModel,
} from '@reflect/core'
import { Button } from '@/components/ui/button.tsx'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select.tsx'
import { useOllamaModels } from '@/hooks/use-ollama-models.ts'
import { useSummaryModelChoice } from '@/hooks/use-summary-model-choice.ts'
import { useSettings } from '@/providers/settings-provider.tsx'
import { OnDeviceAttestationDialog } from './on-device-attestation-dialog.tsx'

/** The command the setup hints suggest for getting a first model. */
const PULL_EXAMPLE = 'ollama pull qwen3'

const ENTRY_PREFIX = 'entry:'
const OLLAMA_PREFIX = 'ollama:'

/** Where an attested entry's model runs, as the picker names it. */
function serverLabel(config: AiProviderConfig): string {
  if (config.provider !== 'openai-compatible') {
    return config.provider
  }
  return config.onDevice?.server === 'ollama' ? 'Ollama' : new URL(config.baseUrl).host
}

function isOllamaEntryFor(config: AiProviderConfig, model: string): boolean {
  return (
    config.provider === 'openai-compatible' &&
    normalizeOpenAICompatibleBaseUrl(config.baseUrl) === OLLAMA_BASE_URL &&
    config.model === model
  )
}

function modelLabel(model: OllamaModel): string {
  return model.parameterSize === null ? model.name : `${model.name} · ${model.parameterSize}`
}

interface HintProps {
  children: ReactNode
}

function Hint({ children }: HintProps): ReactElement {
  return <p className="mt-2 text-xs text-text-muted">{children}</p>
}

/**
 * Settings → All Notes → AI summaries, On this Mac: the model that summarizes.
 * Lists the models already set up to run on this Mac and the ones installed
 * in a running Ollama. Picking an Ollama model asks the user to confirm that
 * it runs here (the same attestation AI providers asks for), then reuses or
 * adds its provider entry. With nothing to pick, it says how to get a model.
 */
export function LocalSummaryModelPicker(): ReactElement {
  const { settings } = useSettings()
  const { chooseLocal, chooseOllamaModel } = useSummaryModelChoice()
  const ollama = useOllamaModels(true)
  const [attesting, setAttesting] = useState<string | null>(null)

  const choice = settings.aiSummariesLocalModel
  const target = localSummaryTarget(
    { providers: settings.aiProviders, defaultProviderId: settings.defaultAiProviderId },
    choice,
  )
  const attested = settings.aiProviders.filter((config) => resolveOnDeviceTarget(config) !== null)
  const installed = ollama.models?.kind === 'ok' ? ollama.models.models : []
  // A model already set up is listed once, as its entry.
  const offered = installed.filter(
    (model) => !attested.some((config) => isOllamaEntryFor(config, model.name)),
  )
  const setUpItems = attested.map((config) => ({
    value: `${ENTRY_PREFIX}${config.id}`,
    label: `${config.model} · ${serverLabel(config)}`,
  }))
  const installedItems = offered.map((model) => ({
    value: `${OLLAMA_PREFIX}${model.name}`,
    label: modelLabel(model),
  }))
  const items = [...setUpItems, ...installedItems]

  function choose(value: string): void {
    if (value.startsWith(OLLAMA_PREFIX)) {
      setAttesting(value.slice(OLLAMA_PREFIX.length))
      return
    }
    const config = attested.find((entry) => `${ENTRY_PREFIX}${entry.id}` === value)
    if (config !== undefined) {
      chooseLocal(config)
    }
  }

  const checkAgain = (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={ollama.checking}
      onClick={ollama.refresh}
      className="mt-2 text-text-secondary"
    >
      Check again
    </Button>
  )
  const pull = <code className="font-mono">{PULL_EXAMPLE}</code>
  let status: ReactNode = null
  if (items.length === 0 && ollama.models === undefined) {
    status = <Hint>Looking for Ollama on this Mac…</Hint>
  } else if (items.length === 0 && ollama.models?.kind !== 'ok') {
    status = (
      <>
        <Hint>
          Ollama isn’t running on this Mac. Install it from ollama.com and open it, then pull a
          model in Terminal, for example {pull}.
        </Hint>
        {checkAgain}
      </>
    )
  } else if (items.length === 0) {
    status = (
      <>
        <Hint>Ollama has no models yet. Pull one in Terminal, for example {pull}.</Hint>
        {checkAgain}
      </>
    )
  } else if (target === null) {
    status = (
      <Hint>
        {choice === null
          ? 'Choose a model to start summarizing.'
          : 'The model chosen for summaries no longer runs on this Mac. Choose another.'}
      </Hint>
    )
  }

  return (
    <>
      {items.length > 0 ? (
        <div className="mt-3 max-w-md">
          <Select
            value={target === null ? '' : `${ENTRY_PREFIX}${target.config.id}`}
            items={items}
            onValueChange={(value) => {
              if (typeof value === 'string') {
                choose(value)
              }
            }}
          >
            <SelectTrigger aria-label="Summary model">
              <SelectValue placeholder="Choose a model" />
            </SelectTrigger>
            <SelectContent>
              {setUpItems.length > 0 ? (
                <SelectGroup>
                  <SelectLabel>Set up on this Mac</SelectLabel>
                  {setUpItems.map(({ value, label }) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ) : null}
              {installedItems.length > 0 ? (
                <SelectGroup>
                  <SelectLabel>Installed in Ollama</SelectLabel>
                  {installedItems.map(({ value, label }) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ) : null}
            </SelectContent>
          </Select>
        </div>
      ) : null}
      {status}
      {attesting === null ? null : (
        <OnDeviceAttestationDialog
          model={attesting}
          baseUrl={OLLAMA_BASE_URL}
          onConfirm={(server) => {
            chooseOllamaModel(attesting, server)
            setAttesting(null)
          }}
          onCancel={() => setAttesting(null)}
        />
      )}
    </>
  )
}
