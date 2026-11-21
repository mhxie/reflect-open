import { useId, useState, type ReactElement } from 'react'
import { Input } from '@/components/ui/input.tsx'
import {
  CONTEXT_WINDOW_ERROR,
  CONTEXT_WINDOW_LABEL,
  parseContextWindowInput,
} from '@/lib/on-device-settings.ts'

interface ContextLengthFieldProps {
  /** The stored context window, if any. Re-key the field when it changes. */
  value: number | undefined
  /** Store a new context window, or `null` to fall back to the server's default. */
  onCommit: (contextWindow: number | null) => void
}

/**
 * A provider row's context-length field: edits stay local until Enter or
 * blur, and only a blank or valid value is committed.
 */
export function ContextLengthField({ value, onCommit }: ContextLengthFieldProps): ReactElement {
  const [draft, setDraft] = useState(value === undefined ? '' : String(value))
  const [invalid, setInvalid] = useState(false)
  const errorId = useId()

  const commit = (): void => {
    const parsed = parseContextWindowInput(draft)
    if (parsed.kind === 'invalid') {
      setInvalid(true)
      return
    }
    setInvalid(false)
    const next = parsed.kind === 'blank' ? null : parsed.tokens
    if ((next ?? undefined) !== value) {
      onCommit(next)
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <label className="flex items-center gap-2">
        <span className="text-xs text-text-secondary">{CONTEXT_WINDOW_LABEL}</span>
        <Input
          inputMode="numeric"
          autoComplete="off"
          placeholder="Server default"
          className="h-7 w-32 text-xs"
          value={draft}
          aria-invalid={invalid}
          aria-describedby={invalid ? errorId : undefined}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              commit()
            }
          }}
        />
      </label>
      {invalid ? (
        <span id={errorId} role="alert" className="text-xs text-red-600 dark:text-red-400">
          {CONTEXT_WINDOW_ERROR}
        </span>
      ) : null}
    </div>
  )
}
