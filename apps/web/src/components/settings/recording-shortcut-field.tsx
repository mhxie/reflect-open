import { useState, type ReactElement } from 'react'
import { DEFAULT_RECORDING_SHORTCUT } from '@reflect/core'
import { Input } from '@/components/ui/input.tsx'
import { SettingsField } from './field.tsx'

interface RecordingShortcutFieldProps {
  /** The stored accelerator, e.g. `Control+Option+Command+M`. */
  value: string
  /** Persist an edited accelerator; empty turns the shortcut off. */
  onSave: (value: string) => void
}

/** The global recording shortcut, saved on blur or Enter; the OS
 * validates it when the setting is applied. */
export function RecordingShortcutField({
  value,
  onSave,
}: RecordingShortcutFieldProps): ReactElement {
  // The parent keys this field by `value`, so a stored change remounts it
  // with a fresh draft.
  const [draft, setDraft] = useState(value)

  function commit(): void {
    const next = draft.trim()
    if (next !== value) {
      onSave(next)
    }
  }

  return (
    <SettingsField
      legend="Shortcut"
      description="Starts and stops a recording from any app. Leave it empty to turn it off."
    >
      <Input
        aria-label="Recording shortcut"
        className="mt-2 max-w-72 font-mono text-xs"
        value={draft}
        placeholder={DEFAULT_RECORDING_SHORTCUT}
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            commit()
          }
        }}
      />
    </SettingsField>
  )
}
