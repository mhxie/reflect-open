import { useState, type ReactElement } from 'react'
import { normalizeWikiTrustReportPath } from '@reflect/core'
import { useWikiTrustReport, type WikiTrustReportState } from '@/hooks/use-wiki-trust-report.ts'
import { formatRecencyLabel } from '@/lib/dates.ts'
import { cn } from '@/lib/utils.ts'
import { useSettings } from '@/providers/settings-provider.tsx'
import { SettingsField } from './field.tsx'

const INPUT_CLASS =
  'w-full max-w-md rounded-[7px] border border-border-strong bg-input-bg px-2.5 py-1.5 font-mono text-[13px] text-text shadow-input placeholder:text-text-muted'

interface Status {
  readonly tone: 'ok' | 'quiet' | 'problem'
  readonly text: string
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

function statusOf(
  state: WikiTrustReportState,
  prefs: Parameters<typeof formatRecencyLabel>[1],
): Status | null {
  switch (state.status) {
    case 'off':
    case 'loading':
      return null
    case 'missing':
      return {
        tone: 'quiet',
        text: 'No report yet. Your agent harness writes it here; Settings → Agents installs a skill that tells it how.',
      }
    case 'unreadable':
    case 'invalid': {
      const error =
        state.status === 'unreadable' ? `Couldn’t read the report: ${state.error}` : state.error
      return {
        tone: 'problem',
        text: state.last === null ? error : `${error} Showing the last report that loaded.`,
      }
    }
    case 'ready': {
      const { report, ignored } = state
      let claims = 0
      for (const note of report.notes.values()) claims += note.claims.size
      const written = Date.parse(report.generatedAt)
      const parts = [
        [report.harness.name, report.harness.version].filter(Boolean).join(' '),
        Number.isNaN(written) ? null : `written ${formatRecencyLabel(written, prefs)}`,
        `${plural(claims, 'claim')} in ${plural(report.notes.size, 'note')}`,
        ignored > 0 ? `${plural(ignored, 'entry')} ignored` : null,
      ]
      return { tone: 'ok', text: parts.filter(Boolean).join(' · ') }
    }
  }
}

/**
 * Settings → Wiki → Trust report: where the agent harness writes its verdicts,
 * and what Reflect last read there. The path commits on Enter or blur, once it
 * names a JSON file Reflect may read.
 */
export function WikiTrustReportField(): ReactElement {
  const { settings, updateSettings } = useSettings()
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const state = useWikiTrustReport(true)
  const status = statusOf(state, settings)
  const value = draft ?? settings.wikiTrustReportPath

  const commit = (): void => {
    if (draft === null) return
    const path = normalizeWikiTrustReportPath(draft)
    if (path === null) {
      setError('Use a .json path inside the graph, outside .reflect/ and .git/.')
      return
    }
    updateSettings({ wikiTrustReportPath: path })
    setDraft(null)
    setError(null)
  }

  return (
    <SettingsField
      legend="Trust report"
      description="The file, relative to the graph, where your agent harness publishes claim verdicts."
    >
      <input
        type="text"
        value={value}
        spellCheck={false}
        aria-label="Trust report path"
        aria-invalid={error !== null}
        aria-describedby="wiki-trust-report-status"
        onChange={(event) => {
          setDraft(event.target.value)
          setError(null)
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit()
          if (event.key === 'Escape') {
            setDraft(null)
            setError(null)
          }
        }}
        className={cn(INPUT_CLASS, 'mt-3')}
      />
      <p
        id="wiki-trust-report-status"
        role={error !== null || status?.tone === 'problem' ? 'alert' : 'status'}
        className={cn(
          'mt-2 text-xs',
          error !== null || status?.tone === 'problem'
            ? 'text-destructive'
            : status?.tone === 'ok'
              ? 'text-text-secondary'
              : 'text-text-muted',
        )}
      >
        {error ?? status?.text ?? ''}
      </p>
    </SettingsField>
  )
}
