import type { ReactElement } from 'react'

interface OnDeviceAttestationCopyProps {
  /** The model id the attestation would name. */
  model: string
  /** The endpoint the attestation would name. */
  baseUrl: string
}

/**
 * What turning on "Runs on this Mac" means, naming the exact model and
 * endpoint: what Reflect checks, what it cannot see, and when to turn it on.
 * It claims no more than the transport proves. Rendered inline, so the caller
 * supplies the paragraph.
 */
export function OnDeviceAttestationCopy({
  model,
  baseUrl,
}: OnDeviceAttestationCopyProps): ReactElement {
  return (
    <>
      Reflect will treat <span className="font-medium text-text">{model}</span> at{' '}
      <span className="font-mono text-text">{baseUrl}</span> as running on this Mac. Reflect can use
      it to read private notes; vision models can also run local OCR. Reflect connects only to this
      Mac, checks Ollama model provenance, with no proxy and no redirects, but cannot see what
      another local server does next. Turn this on only if the server runs the model on this Mac and
      does not forward requests (Ollama cloud models, LiteLLM, SSH tunnels and similar gateways do).
    </>
  )
}
