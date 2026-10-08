import type { ReactElement } from 'react'
import type { WikiTrustDisplay } from '@reflect/core'
import { useSettings } from '@/providers/settings-provider.tsx'
import { cn } from '@/lib/utils.ts'
import { SettingsField } from './field.tsx'
import { SettingsOptionCard } from './option-card.tsx'
import { WikiTrustDisplayPreview } from './wiki-trust-display-preview.tsx'

interface DisplayOption {
  readonly value: WikiTrustDisplay
  readonly label: string
  readonly hint: string
}

const OPTIONS: readonly DisplayOption[] = [
  { value: 'inline', label: 'Inline', hint: 'After each claim' },
  { value: 'margin', label: 'Margin', hint: 'Beside the paragraph' },
  { value: 'on-demand', label: 'On demand', hint: 'While you hold ⌥' },
  { value: 'off', label: 'Off', hint: 'No marks' },
]

/**
 * Settings → Wiki → Claim trust: how the harness's verdicts show while
 * reading, as radio cards. The three styles show the same report.
 */
export function WikiTrustDisplayField(): ReactElement {
  const { settings, updateSettings } = useSettings()
  return (
    <SettingsField
      legend="Claim trust"
      description="How your agent harness’s verdicts appear while you read a wiki article."
    >
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {OPTIONS.map(({ value, label, hint }) => {
          const selected = settings.wikiTrustDisplay === value
          return (
            <SettingsOptionCard
              key={value}
              selected={selected}
              className={cn(
                'flex-col items-start gap-1.5 px-3 py-2.5',
                selected ? 'text-accent-soft-text' : 'text-text-secondary',
              )}
            >
              <input
                type="radio"
                name="wiki-trust-display"
                value={value}
                checked={selected}
                onChange={() => updateSettings({ wikiTrustDisplay: value })}
                className="sr-only"
              />
              <WikiTrustDisplayPreview value={value} />
              <span className="text-xs font-medium">{label}</span>
              <span className="text-[11px] leading-tight text-text-muted">{hint}</span>
            </SettingsOptionCard>
          )
        })}
      </div>
    </SettingsField>
  )
}
