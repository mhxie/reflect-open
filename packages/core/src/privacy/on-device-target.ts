import type { OpenAiCompatibleProviderConfig } from '../settings/schema.ts'

declare const onDeviceTargetBrand: unique symbol

/**
 * A resolved model the user attested runs on this Mac. Only
 * `resolveOnDeviceTarget` in `on-device.ts` creates one; an object literal
 * does not typecheck.
 */
export interface OnDeviceTarget {
  readonly kind: 'on-device'
  readonly config: Readonly<OpenAiCompatibleProviderConfig>
  readonly [onDeviceTargetBrand]: true
}
