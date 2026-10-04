import { DEFAULT_OPENAI_COMPATIBLE_BASE_URL, MIN_CONTEXT_WINDOW } from '@reflect/core'

/**
 * Shared pieces of the on-device provider settings (Plan 27): the switch
 * copy, quick-fill endpoints, and the context-length field's parsing, used by
 * the add form and the provider rows alike. The copy stays neutral until
 * on-device models may read private notes.
 */

/** The label of the attestation switch. */
export const ON_DEVICE_SWITCH_LABEL = 'Runs on this Mac'

/** Why the switch is unavailable for an endpoint off this Mac. */
export const ON_DEVICE_LOOPBACK_HINT = 'Only for localhost, 127.x.x.x or [::1]'

/** The capability checkbox's label. */
export const SUPPORTS_IMAGES_LABEL = 'Can read images'

/** The context-length field's label. */
export const CONTEXT_WINDOW_LABEL = 'Context length (tokens)'

/** Shown when the context-length field holds anything but blank or a valid count. */
export const CONTEXT_WINDOW_ERROR = `Enter a whole number of at least ${MIN_CONTEXT_WINDOW.toLocaleString('en-US')} tokens, or leave it blank.`

/** The badge on a provider row whose attestation holds. */
export function onDeviceBadgeText(model: string): string {
  return `On this Mac · ${model}`
}

/** OpenAI-compatible endpoints of common servers on this Mac, offered as quick fills. */
export const LOCAL_ENDPOINT_PRESETS: ReadonlyArray<{ label: string; baseUrl: string }> = [
  { label: 'Ollama', baseUrl: 'http://localhost:11434/v1' },
  { label: 'LM Studio', baseUrl: DEFAULT_OPENAI_COMPATIBLE_BASE_URL },
]

/** A context-length field's text, read: blank, a token count, or neither. */
export type ContextWindowInput =
  | { kind: 'blank' }
  | { kind: 'tokens'; tokens: number }
  | { kind: 'invalid' }

/**
 * Read a context-length field. Blank means "the server's default"; otherwise
 * it must be a whole number of at least `MIN_CONTEXT_WINDOW` tokens, with
 * digit-group separators allowed (`32,768`).
 */
export function parseContextWindowInput(text: string): ContextWindowInput {
  const digits = text.replaceAll(/[\s,_]/gu, '')
  if (digits === '') {
    return { kind: 'blank' }
  }
  if (!/^\d+$/u.test(digits)) {
    return { kind: 'invalid' }
  }
  const tokens = Number(digits)
  return Number.isSafeInteger(tokens) && tokens >= MIN_CONTEXT_WINDOW
    ? { kind: 'tokens', tokens }
    : { kind: 'invalid' }
}
