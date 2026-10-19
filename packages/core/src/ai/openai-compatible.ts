import { normalizeOpenAICompatibleBaseUrl } from '../lib/http-url.ts'
import { isLoopbackHttpUrl } from '../privacy/loopback.ts'

export const OPENAI_COMPATIBLE_PROVIDER_ID = 'openai-compatible'

export const DEFAULT_OPENAI_COMPATIBLE_BASE_URL = 'http://localhost:1234/v1'

export const DEFAULT_OPENAI_COMPATIBLE_MODEL = 'local-model'

/**
 * Whether a base URL uses plain http to a host other than this machine (see
 * {@link isLoopbackHttpUrl}). Such traffic crosses the network unencrypted,
 * so the add-provider forms show a warning (without blocking — LAN and
 * homelab endpoints are a legitimate setup).
 */
export function isPlainHttpRemoteBaseUrl(value: string): boolean {
  try {
    const url = new URL(normalizeOpenAICompatibleBaseUrl(value))
    return url.protocol === 'http:' && !isLoopbackHttpUrl(url.href)
  } catch {
    return false
  }
}
