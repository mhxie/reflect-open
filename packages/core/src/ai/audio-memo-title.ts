import { z } from 'zod'
import type { AiProviderConfig } from '../settings/schema.ts'
import { wikiLinkSafe } from '../markdown/edit.ts'
import { languageModel } from './language-model.ts'
import { smallModelConfig } from './small-model.ts'
import { clipAtWordBoundary } from './text.ts'

const TITLE_TIMEOUT_MS = 30_000
const MAX_TRANSCRIPT_CHARS = 4_000
const MAX_TITLE_CHARS = 80
const MAX_FALLBACK_WORDS = 8

const audioMemoTitleSchema = z.object({
  title: z.string(),
})

export interface AudioMemoEnrichmentCredentials {
  /** The provider entry whose provider selects the fixed small enrichment model. */
  readonly config: AiProviderConfig
  /** The BYOK API key, or an empty string for no-key compatible endpoints. */
  readonly apiKey: string
}

export interface GenerateAudioMemoTitleRequest {
  /** Optional title-generation credentials; omitted means local fallback only. */
  readonly credentials?: AudioMemoEnrichmentCredentials | undefined
  /** Host transport (the Tauri HTTP plugin's fetch; tests pass a stub). */
  readonly fetchFn?: typeof fetch | undefined
  /** The memo transcript to name. */
  readonly transcript: string
  /** Timestamp-derived fallback when the transcript cannot produce a title. */
  readonly fallbackTitle: string
}

function firstContentLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== '') ?? ''
  )
}

/** Sanitize and length-bound a generated title for Markdown and wiki-link use. */
export function normalizedAudioMemoTitle(candidate: string): string | null {
  const safe = wikiLinkSafe(firstContentLine(candidate))
    .replace(/[.!?]+$/u, '')
    .trim()
  const clipped = clipAtWordBoundary(safe, MAX_TITLE_CHARS)
  return clipped === '' ? null : clipped
}

function titleCaseFallback(text: string): string {
  return text
    .split(/\s+/)
    .filter((word) => word !== '')
    .slice(0, MAX_FALLBACK_WORDS)
    .map((word, index) => {
      const lower = word.toLocaleLowerCase()
      return index === 0 ? lower.charAt(0).toLocaleUpperCase() + lower.slice(1) : lower
    })
    .join(' ')
}

/** Derive a short local title from the transcript without making a provider call. */
export function transcriptFallbackTitle(transcript: string, fallbackTitle: string): string {
  const firstSentence = firstContentLine(transcript).split(/[.!?]/u)[0] ?? ''
  const normalized = normalizedAudioMemoTitle(titleCaseFallback(firstSentence))
  return normalized ?? fallbackTitle
}

function titlePrompt(transcript: string): string {
  return [
    'Name this audio memo from its transcript.',
    'Return a short human title, 3 to 7 words.',
    'Use the language of the transcript.',
    'Return only the title: no quotes, no markdown, no punctuation unless it is part of a name.',
    '',
    `Transcript:\n${transcript.slice(0, MAX_TRANSCRIPT_CHARS)}`,
  ].join('\n')
}

/**
 * Generate a concise, content-derived memo title. Provider failures are
 * non-fatal because the transcript is already durable; callers still get a
 * deterministic title from the transcript before falling back to the timestamp.
 */
export async function generateAudioMemoTitle(
  request: GenerateAudioMemoTitleRequest,
): Promise<string> {
  const fallback = transcriptFallbackTitle(request.transcript, request.fallbackTitle)
  if (request.transcript.trim() === '') {
    return request.fallbackTitle
  }
  if (request.credentials === undefined) {
    return fallback
  }
  const titleConfig = smallModelConfig(request.credentials.config)
  if (titleConfig === null) {
    return fallback
  }
  try {
    const { generateText, Output } = await import('@reflect/modules/ai')
    const result = await generateText({
      model: await languageModel(titleConfig, request.credentials.apiKey, request.fetchFn ?? fetch),
      output: Output.object({ schema: audioMemoTitleSchema }),
      prompt: titlePrompt(request.transcript),
      abortSignal: AbortSignal.timeout(TITLE_TIMEOUT_MS),
      maxRetries: 0,
    })
    return normalizedAudioMemoTitle(result.output.title) ?? fallback
  } catch {
    return fallback
  }
}
