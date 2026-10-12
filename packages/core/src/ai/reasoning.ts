import type { ModelTarget } from '../privacy/on-device.ts'

/**
 * Whether a one-shot extraction call (a note summary, an asset's OCR
 * description) should switch the model's reasoning off. Neither gains from
 * it, yet Ollama runs a thinking-capable model with reasoning on unless told
 * otherwise, spending several times the answer's tokens per call and pushing
 * long inputs past their timeouts. Only an attested Ollama server is told: it
 * accepts `reasoning_effort: "none"`; other servers and cloud providers keep
 * their default.
 */
export function skipsReasoning(target: ModelTarget): boolean {
  return target.kind === 'on-device' && target.config.onDevice?.server === 'ollama'
}
