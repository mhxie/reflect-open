import { ReflectError } from '../errors.ts'
import { AI_SUMMARY_MAX_CHARS } from '../markdown/ai-summary.ts'
import type { CloudNoteContent, CloudSafe } from '../privacy/checkers.ts'
import type { CloudTarget, VerifiedOnDeviceTarget } from '../privacy/on-device.ts'
import type { TargetModel } from './language-model.ts'
import { clipAtWordBoundary } from './text.ts'

/**
 * One short plain-text summary of a note, for the All Notes row preview.
 * Privacy is structural: an on-device model (verified for this pass) takes
 * any note, a cloud model only content minted by `cloudSafeNoteContent`, so
 * a private note's body cannot typecheck its way to a provider.
 */

const SUMMARY_TIMEOUT_MS = 60_000

/** Body characters sent to the model; local models often have small contexts. */
export const MAX_SUMMARY_SOURCE_CHARS = 12_000

/** A note as the summarizer reads it: its title and (capped) Markdown body. */
export interface NoteSummarySource {
  readonly title: string
  readonly content: string
}

/** Who summarizes: a verified on-device model, or a cloud model over gated content. */
export type SummarizeNoteRequest =
  | {
      readonly model: TargetModel<VerifiedOnDeviceTarget>
      readonly note: NoteSummarySource
    }
  | {
      readonly model: TargetModel<CloudTarget>
      readonly note: CloudSafe<CloudNoteContent>
    }

function summaryPrompt(note: NoteSummarySource): string {
  return [
    'Summarize this note for a one-line preview in a list of notes.',
    'Write one plain sentence of at most 25 words, in the language of the note.',
    'Say what the note is about; do not start with "This note" and do not repeat the title.',
    'Return only the sentence: no quotes, no Markdown, no preamble.',
    '',
    `Title: ${note.title}`,
    '',
    `Note:\n${note.content.slice(0, MAX_SUMMARY_SOURCE_CHARS)}`,
  ].join('\n')
}

/**
 * The model's answer as a one-line summary: its first non-empty line, with
 * wrapping quotes and Markdown emphasis dropped, whitespace collapsed, and a
 * whole-word cut at {@link AI_SUMMARY_MAX_CHARS}. `null` when nothing is left.
 */
export function normalizedNoteSummary(answer: string): string | null {
  const line =
    answer
      .split(/\r?\n/)
      .map((candidate) => candidate.trim())
      .find((candidate) => candidate !== '') ?? ''
  const plain = line
    .replace(/^(?:summary|tl;?dr)\s*:\s*/iu, '')
    .replaceAll(/[*_`]+/gu, '')
    .replaceAll(/^["'“‘«]+|["'”’»]+$/gu, '')
    .replaceAll(/\s+/gu, ' ')
    .trim()
  const clipped = clipAtWordBoundary(plain, AI_SUMMARY_MAX_CHARS)
  return clipped === '' ? null : clipped
}

function classify(
  cause: unknown,
  sdk: Pick<typeof import('@reflect/modules/ai'), 'APICallError'>,
): Error | null {
  if (sdk.APICallError.isInstance(cause)) {
    const status = cause.statusCode ?? 0
    if (status === 401 || status === 403) {
      return new ReflectError('auth', `the provider rejected the API key (${status})`)
    }
    if (status === 429 || status >= 500) {
      return new ReflectError('network', `the provider is unavailable (${status})`)
    }
    if (status >= 400) {
      return null
    }
  }
  if (cause instanceof DOMException && cause.name === 'TimeoutError') {
    return new ReflectError('network', 'the summary request timed out')
  }
  return cause instanceof Error ? cause : new Error(String(cause))
}

/**
 * Summarize one note. Resolves `null` when the model refused this note (a
 * 4xx other than auth) or answered nothing usable — retrying the same note
 * can't help. Throws {@link ReflectError} (`auth`, `network`) for failures the
 * caller should retry later; the summary pass is the retry layer
 * (`maxRetries: 0`).
 */
export async function summarizeNote(request: SummarizeNoteRequest): Promise<string | null> {
  const sdk = await import('@reflect/modules/ai')
  try {
    const result = await sdk.generateText({
      model: request.model.model,
      prompt: summaryPrompt(request.note),
      abortSignal: AbortSignal.timeout(SUMMARY_TIMEOUT_MS),
      maxRetries: 0,
    })
    return normalizedNoteSummary(result.text)
  } catch (cause) {
    const error = classify(cause, sdk)
    if (error === null) {
      return null
    }
    throw error
  }
}
