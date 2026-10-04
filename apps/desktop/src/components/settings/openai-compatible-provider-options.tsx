import { useId, useState, type ReactElement } from 'react'
import {
  isLoopbackHttpUrl,
  resolveOnDeviceTarget,
  type AiProviderCapabilities,
  type OpenAiCompatibleProviderConfig,
} from '@reflect/core'
import { Checkbox } from '@/components/ui/checkbox.tsx'
import { Switch } from '@/components/ui/switch.tsx'
import { InlineAlert } from '@/components/inline-alert.tsx'
import {
  ON_DEVICE_LOOPBACK_HINT,
  ON_DEVICE_SWITCH_LABEL,
  SUPPORTS_IMAGES_LABEL,
} from '@/lib/on-device-settings.ts'
import { ContextLengthField } from './context-length-field.tsx'
import { OnDeviceAttestationDialog } from './on-device-attestation-dialog.tsx'

interface OpenAiCompatibleProviderOptionsProps {
  config: OpenAiCompatibleProviderConfig
  /** Attest (after the dialog) or withdraw "runs on this Mac". */
  onSetOnDevice: (id: string, attest: boolean) => void
  /** Change what the entry declares about its model. */
  onSetCapabilities: (id: string, capabilities: AiProviderCapabilities) => void
}

/**
 * An OpenAI-compatible row's extra settings: the "Runs on this Mac"
 * attestation (turning it on asks first, naming the endpoint and model;
 * turning it off applies at once), a re-confirm notice when a stored
 * attestation no longer matches, and what the model accepts.
 */
export function OpenAiCompatibleProviderOptions({
  config,
  onSetOnDevice,
  onSetCapabilities,
}: OpenAiCompatibleProviderOptionsProps): ReactElement {
  const [confirming, setConfirming] = useState(false)
  const labelId = useId()
  const hintId = useId()
  const loopback = isLoopbackHttpUrl(config.baseUrl)
  const attested = resolveOnDeviceTarget(config) !== null
  // Changing the model drops the attestation, so a mismatch means a hand edit.
  const stale = !attested && (config.onDevice ?? null) !== null

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-2">
          <Switch
            size="sm"
            aria-labelledby={labelId}
            aria-describedby={loopback ? undefined : hintId}
            checked={attested}
            disabled={!loopback}
            onCheckedChange={(checked) => {
              if (checked) {
                setConfirming(true)
              } else {
                onSetOnDevice(config.id, false)
              }
            }}
          />
          <span id={labelId} className="text-xs text-text-secondary">
            {ON_DEVICE_SWITCH_LABEL}
          </span>
          {loopback ? null : (
            <span id={hintId} className="text-xs text-text-muted">
              {ON_DEVICE_LOOPBACK_HINT}
            </span>
          )}
        </div>
        <label className="flex items-center gap-2">
          <Checkbox
            aria-label={SUPPORTS_IMAGES_LABEL}
            checked={config.supportsImages === true}
            onCheckedChange={(checked) => onSetCapabilities(config.id, { supportsImages: checked })}
          />
          <span className="text-xs text-text-secondary">{SUPPORTS_IMAGES_LABEL}</span>
        </label>
        <ContextLengthField
          key={config.contextWindow ?? 'default'}
          value={config.contextWindow}
          onCommit={(contextWindow) => onSetCapabilities(config.id, { contextWindow })}
        />
      </div>
      {stale ? (
        <InlineAlert tone="warning">Re-confirm: endpoint or model changed</InlineAlert>
      ) : null}
      {confirming ? (
        <OnDeviceAttestationDialog
          model={config.model}
          baseUrl={config.baseUrl}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false)
            onSetOnDevice(config.id, true)
          }}
        />
      ) : null}
    </div>
  )
}
