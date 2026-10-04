import { useId, type ReactElement } from 'react'
import { useFormContext, useWatch } from 'react-hook-form'
import { isLoopbackHttpUrl } from '@reflect/core'
import { Button } from '@/components/ui/button.tsx'
import { Checkbox } from '@/components/ui/checkbox.tsx'
import { Input } from '@/components/ui/input.tsx'
import { Switch } from '@/components/ui/switch.tsx'
import {
  CONTEXT_WINDOW_ERROR,
  CONTEXT_WINDOW_LABEL,
  LOCAL_ENDPOINT_PRESETS,
  ON_DEVICE_LOOPBACK_HINT,
  ON_DEVICE_SWITCH_LABEL,
  SUPPORTS_IMAGES_LABEL,
  parseContextWindowInput,
} from '@/lib/on-device-settings.ts'
import type { AddAiProviderValues } from './add-ai-provider-form.tsx'
import { OnDeviceAttestationCopy } from './on-device-attestation-copy.tsx'

const FIELD_LABEL_CLASS = 'text-xs font-medium text-text-secondary'

interface AddAiProviderLocalFieldsProps {
  /** A quick fill replaced the endpoint (the key's verification no longer applies). */
  onEndpointChange: () => void
}

/**
 * The add form's OpenAI-compatible extras, read through `FormProvider`:
 * quick fills for common local servers, the "Runs on this Mac" attestation
 * (offered for loopback endpoints only, and spelled out once it is on),
 * image input, and an optional context length.
 */
export function AddAiProviderLocalFields({
  onEndpointChange,
}: AddAiProviderLocalFieldsProps): ReactElement {
  const { control, register, setValue, formState } = useFormContext<AddAiProviderValues>()
  const [baseUrl, model, onDevice, supportsImages] = useWatch({
    control,
    name: ['baseUrl', 'model', 'onDevice', 'supportsImages'],
  })
  const labelId = useId()
  const hintId = useId()
  const loopback = isLoopbackHttpUrl(baseUrl)

  return (
    <>
      <div className="-mt-1 flex items-center gap-1.5">
        <span className="text-xs text-text-muted">Fill in</span>
        {LOCAL_ENDPOINT_PRESETS.map((preset) => (
          <Button
            key={preset.label}
            type="button"
            variant="outline"
            size="xs"
            onClick={() => {
              setValue('baseUrl', preset.baseUrl, { shouldValidate: true })
              onEndpointChange()
            }}
          >
            {preset.label}
          </Button>
        ))}
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <Switch
            aria-labelledby={labelId}
            aria-describedby={loopback ? undefined : hintId}
            checked={onDevice && loopback}
            disabled={!loopback}
            onCheckedChange={(checked) => setValue('onDevice', checked)}
          />
          <span id={labelId} className="text-sm text-text">
            {ON_DEVICE_SWITCH_LABEL}
          </span>
        </div>
        {loopback ? null : (
          <span id={hintId} className="text-xs text-text-muted">
            {ON_DEVICE_LOOPBACK_HINT}
          </span>
        )}
        {onDevice && loopback ? (
          <p className="text-xs text-text-muted">
            <OnDeviceAttestationCopy
              model={model.trim() || 'this model'}
              baseUrl={baseUrl.trim()}
            />
          </p>
        ) : null}
      </div>

      <label className="flex items-center gap-2">
        <Checkbox
          aria-label={SUPPORTS_IMAGES_LABEL}
          checked={supportsImages}
          onCheckedChange={(checked) => setValue('supportsImages', checked)}
        />
        <span className="text-sm text-text">{SUPPORTS_IMAGES_LABEL}</span>
      </label>

      <label className="flex flex-col gap-1">
        <span className={FIELD_LABEL_CLASS}>{CONTEXT_WINDOW_LABEL}</span>
        <Input
          inputMode="numeric"
          autoComplete="off"
          placeholder="Server default"
          {...register('contextWindow', {
            validate: (value) =>
              parseContextWindowInput(value).kind !== 'invalid' || CONTEXT_WINDOW_ERROR,
          })}
        />
        {formState.errors.contextWindow ? (
          <span role="alert" className="text-xs text-red-600 dark:text-red-400">
            {formState.errors.contextWindow.message}
          </span>
        ) : null}
      </label>
    </>
  )
}
