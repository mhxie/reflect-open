/**
 * A signal that aborts after `ms` with a `TimeoutError`, or when `signal`
 * aborts if that comes first, with its reason. It stands in for
 * `AbortSignal.any([AbortSignal.timeout(ms), signal])`: `any` needs Safari
 * 17.4 and `timeout` Safari 16, newer than the oldest WebKit the apps support.
 */
export function timeoutSignal(ms: number, signal?: AbortSignal): AbortSignal {
  const combined = new AbortController()
  if (signal?.aborted) {
    combined.abort(signal.reason)
    return combined.signal
  }
  const timer = setTimeout(() => {
    combined.abort(new DOMException('The operation timed out.', 'TimeoutError'))
  }, ms)
  combined.signal.addEventListener(
    'abort',
    () => {
      clearTimeout(timer)
    },
    { once: true },
  )
  // Removed once the combined signal aborts, whichever source fired.
  signal?.addEventListener(
    'abort',
    () => {
      combined.abort(signal.reason)
    },
    { once: true, signal: combined.signal },
  )
  return combined.signal
}
