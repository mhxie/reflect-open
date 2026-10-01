import type { ReactElement } from 'react'
import { SEMANTIC_MODELS, type SemanticModelId } from '@reflect/core'
import { formatModelSize } from '@/lib/format-model-size.ts'
import { retryFailedEmbeddings } from '@/lib/semantic.ts'
import { cn } from '@/lib/utils.ts'
import { useSettings } from '@/providers/settings-provider.tsx'
import { SettingsField } from './field.tsx'
import { SettingsOptionCard } from './option-card.tsx'

/**
 * The embedding model behind semantic search. EmbeddingsSync loads a newly
 * chosen model, refits the vector table to its width, and re-embeds every
 * note, so a switch costs one full pass over the graph.
 */
export function SemanticModelField(): ReactElement {
  const { settings, updateSettings } = useSettings()
  const model = settings.semanticModel

  function choose(next: SemanticModelId): void {
    updateSettings({ semanticModel: next })
    // EmbeddingsSync never retries a failed load on its own; choosing a model
    // is an explicit action, so it does.
    if (settings.semanticSearchEnabled) {
      void retryFailedEmbeddings(next)
    }
  }

  return (
    <SettingsField
      legend="Semantic search model"
      description="Multilingual models also match notes written in other languages. Changing the model re-embeds every note on this device, which takes a while in a large graph."
    >
      <div className="mt-3 @container">
        <div className="grid grid-cols-1 gap-2 @xl:grid-cols-2">
          {SEMANTIC_MODELS.map((option) => {
            const selected = model === option.id
            return (
              <SettingsOptionCard
                key={option.id}
                selected={selected}
                className="items-start justify-between gap-3 px-3 py-2.5"
              >
                <span className="min-w-0 flex-1">
                  <span
                    className={cn('block text-sm font-medium', selected && 'text-accent-soft-text')}
                  >
                    {option.label}
                  </span>
                  <span className="mt-0.5 block text-xs text-text-muted">
                    {option.description} · {formatModelSize(option.sizeBytes)}
                  </span>
                </span>
                <input
                  type="radio"
                  name="semantic-model"
                  value={option.id}
                  checked={selected}
                  onChange={() => choose(option.id)}
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
