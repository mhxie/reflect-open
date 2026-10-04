/**
 * Loopback detection for model servers on this Mac (Ollama, LM Studio, any
 * OpenAI-compatible endpoint). A leaf module on purpose: the settings schema
 * reaches it through `ai/openai-compatible.ts`, so it must not import
 * anything that imports the schema back. `./on-device.ts` re-exports it.
 */

/** An IPv4 host as WHATWG serializes it (always a dotted quad) in 127.0.0.0/8. */
const LOOPBACK_IPV4_HOST = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u

/**
 * Whether `value` is an http(s) URL without credentials whose host is
 * literally this Mac: exactly `localhost`, an IPv4 address in 127.0.0.0/8,
 * or `[::1]`.
 *
 * The check reads the WHATWG-normalized host, so spellings such as `127.1`
 * or `[0:0:0:0:0:0:0:1]` count, while `localhost.`, `*.localhost`,
 * IPv4-mapped IPv6 addresses and every LAN or VPN address do not. Nothing is
 * resolved here; the Rust transport answers `localhost` with 127.0.0.1
 * itself. Its twin, `on_device_http::loopback_url`, is pinned to this
 * predicate by `fixtures/loopback-urls.json`.
 */
export function isLoopbackHttpUrl(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return false
  }
  if (url.username !== '' || url.password !== '') {
    return false
  }
  return (
    url.hostname === 'localhost' ||
    url.hostname === '[::1]' ||
    LOOPBACK_IPV4_HOST.test(url.hostname)
  )
}
