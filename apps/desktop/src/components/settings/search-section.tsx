import type { ReactElement, ReactNode } from 'react'
import { Sparkles } from 'lucide-react'
import { semanticModel } from '@reflect/core'
import { InlineAlert } from '@/components/inline-alert.tsx'
import { formatModelSize } from '@/lib/format-model-size.ts'
import { ensureEmbeddingsVisibly, retryFailedEmbeddings } from '@/lib/semantic.ts'
import { useSemanticIndexProgress } from '@/lib/semantic-index-progress.ts'
import { useEmbedStatus } from '@/lib/use-embed-status.ts'
import { useSettings } from '@/providers/settings-provider.tsx'
import { DescribeAssetsField } from './describe-assets-field.tsx'
import { SettingsField } from './field.tsx'
import { ModelDownloadProgress } from './model-download-progress.tsx'
import { RebuildIndexField } from './rebuild-index-field.tsx'
import { SettingsSection } from './section.tsx'
import { SemanticIndexProgressBar } from './semantic-index-progress-bar.tsx'
import { SemanticModelField } from './semantic-model-field.tsx'

/**
 * The search settings: the semantic-search opt-in (Plan 09), its model, and
 * the index rebuild action. Enabling semantic search persists
 * `semanticSearchEnabled`; EmbeddingsSync reacts by loading the chosen model,
 * whose first download streams through this section as a progress bar (the
 * `embed:status` events carry byte counts), and so does the embedding pass
 * that follows a model switch.
 */
export function SearchSection(): ReactElement {
  const { settings, updateSettings } = useSettings()
  const status = useEmbedStatus()
  const indexProgress = useSemanticIndexProgress()

  let control: ReactNode
  if (!settings.semanticSearchEnabled) {
    // Disabling takes effect immediately — every semantic consumer gates on
    // the setting, so the still-loaded model just idles. No caveat needed.
    control = (
      <button
        type="button"
        onClick={() => {
          updateSettings({ semanticSearchEnabled: true })
          // EmbeddingsSync loads an untouched runtime; a `failed` one only
          // retries on an explicit action like this.
          void retryFailedEmbeddings(settings.semanticModel)
        }}
        className="inline-flex items-center gap-1.5 rounded-md bg-accent px-2.5 py-1.5 text-xs font-medium text-text-on-brand shadow-sm transition-colors duration-100 hover:bg-accent-hover"
      >
        <Sparkles aria-hidden strokeWidth={1.75} className="size-3.5" />
        Enable semantic search
      </button>
    )
  } else if (status.status === 'ready') {
    control = (
      <div>
        <div className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-2 text-xs text-text-muted">
            <span aria-hidden className="size-1.5 rounded-full bg-emerald-500" />
            Model downloaded ({semanticModel(status.model).label})
          </span>
          <button
            type="button"
            onClick={() => updateSettings({ semanticSearchEnabled: false })}
            className="shrink-0 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-text-secondary transition-colors duration-100 hover:bg-surface-hover"
          >
            Disable
          </button>
        </div>
        {indexProgress !== null ? <SemanticIndexProgressBar progress={indexProgress} /> : null}
      </div>
    )
  } else if (status.status === 'failed') {
    control = (
      <div>
        <InlineAlert tone="error">Couldn’t load the model: {status.message}</InlineAlert>
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            onClick={() => void ensureEmbeddingsVisibly(settings.semanticModel)}
            className="rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-text-secondary transition-colors duration-100 hover:bg-surface-hover"
          >
            Try again
          </button>
          <button
            type="button"
            onClick={() => updateSettings({ semanticSearchEnabled: false })}
            className="rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-text-secondary transition-colors duration-100 hover:bg-surface-hover"
          >
            Disable
          </button>
        </div>
      </div>
    )
  } else {
    // `loading`, or the `uninitialized` beat before EmbeddingsSync reacts.
    control = (
      <ModelDownloadProgress progress={status.status === 'loading' ? status.progress : undefined} />
    )
  }

  const model = semanticModel(settings.semanticModel)
  return (
    <SettingsSection id="search">
      <SettingsField
        legend="Semantic search"
        description={`Find notes by meaning, not just keywords — smarter ⌘K results and related notes. Runs entirely on this device; enabling downloads ${model.label} (${formatModelSize(model.sizeBytes)}) once.`}
      >
        <div className="mt-3">{control}</div>
      </SettingsField>
      {/* The model is a choice within semantic search, offered once it's on. */}
      {settings.semanticSearchEnabled ? <SemanticModelField /> : null}
      <DescribeAssetsField />
      <RebuildIndexField />
    </SettingsSection>
  )
}
