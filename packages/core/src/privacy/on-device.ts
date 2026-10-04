import { resolveChatModel, type ChatModelOption } from '../ai/chat/model-options.ts'
import { defaultAiProvider, type AiProvidersState } from '../ai/provider-config.ts'
import type { AiProviderConfig, OpenAiCompatibleProviderConfig } from '../settings/schema.ts'
import { isLoopbackHttpUrl } from './loopback.ts'

/**
 * Which tier a resolved model belongs to. A model counts as running on this
 * Mac only when the user attested it: an OpenAI-compatible entry on a literal
 * loopback host whose `onDevice` attestation names exactly the endpoint and
 * model being called. Reflect can prove only that requests reach a loopback
 * socket (the transport in `ai/on-device-fetch.ts`); whether the server keeps
 * them there rests on that attestation. Everything else is cloud tier.
 *
 * The proof is a branded {@link OnDeviceTarget}, minted only here, holding a
 * frozen copy of the config it was minted for. Building the model from that
 * copy (`languageModelFor`) means a target cannot be paired with another
 * entry, such as an undeclared tunnel on another loopback port.
 */

export { isLoopbackHttpUrl } from './loopback.ts'

declare const onDeviceTargetBrand: unique symbol

/**
 * A resolved model the user attested runs on this Mac. Only
 * {@link resolveOnDeviceTarget} creates one; an object literal does not
 * typecheck.
 */
export interface OnDeviceTarget {
  readonly kind: 'on-device'
  readonly config: Readonly<OpenAiCompatibleProviderConfig>
  readonly [onDeviceTargetBrand]: true
}

/** Any other resolved model: content bound for it must pass the cloud gate. */
export interface CloudTarget {
  readonly kind: 'cloud'
  readonly config: Readonly<AiProviderConfig>
}

/** Where a resolved model runs, as far as Reflect can tell. */
export type ModelTarget = OnDeviceTarget | CloudTarget

function frozenOpenAiCompatible(
  config: OpenAiCompatibleProviderConfig,
): Readonly<OpenAiCompatibleProviderConfig> {
  return Object.freeze(
    config.onDevice
      ? { ...config, onDevice: Object.freeze({ ...config.onDevice }) }
      : { ...config },
  )
}

function frozenConfig(config: AiProviderConfig): Readonly<AiProviderConfig> {
  return config.provider === 'openai-compatible'
    ? frozenOpenAiCompatible(config)
    : Object.freeze({ ...config })
}

/** The one place an {@link OnDeviceTarget} is born. Private by design. */
function mintOnDeviceTarget(config: OpenAiCompatibleProviderConfig): OnDeviceTarget {
  // The brand has no runtime representation, so this assertion is the whole
  // mint; the guarantees live in resolveOnDeviceTarget's checks.
  return Object.freeze({
    kind: 'on-device',
    config: frozenOpenAiCompatible(config),
  }) as OnDeviceTarget
}

/**
 * The on-device target for `resolved`, a config after the picked model id was
 * applied (`resolveChatModel`, or a per-run model override), or `null`. All
 * of these must hold: it is an OpenAI-compatible entry, its base URL is a
 * loopback host, and its attestation names exactly this base URL and this
 * model. Anything else fails closed, including a hand-edited base URL and
 * the catalog's placeholder model id when that id was not the one attested.
 */
export function resolveOnDeviceTarget(resolved: AiProviderConfig): OnDeviceTarget | null {
  if (resolved.provider !== 'openai-compatible') {
    return null
  }
  const attestation = resolved.onDevice
  if (attestation === undefined || attestation === null) {
    return null
  }
  if (
    !isLoopbackHttpUrl(resolved.baseUrl) ||
    attestation.baseUrl !== resolved.baseUrl ||
    attestation.model !== resolved.model
  ) {
    return null
  }
  return mintOnDeviceTarget(resolved)
}

/**
 * The target for `resolved`: on-device when {@link resolveOnDeviceTarget}
 * allows it, cloud otherwise. The config is a frozen copy either way.
 */
export function modelTarget(resolved: AiProviderConfig): ModelTarget {
  const onDevice = resolveOnDeviceTarget(resolved)
  if (onDevice !== null) {
    return onDevice
  }
  const cloud: CloudTarget = { kind: 'cloud', config: frozenConfig(resolved) }
  return Object.freeze(cloud)
}

/**
 * Whether choosing `option` in the chat model picker gives an on-device
 * target, by the rule a chat turn resolves its model with
 * (`resolveChatModel`).
 */
export function isOnDeviceOption(state: AiProvidersState, option: ChatModelOption): boolean {
  const resolved = resolveChatModel(state, { configId: option.configId, modelId: option.modelId })
  return resolved !== null && resolveOnDeviceTarget(resolved) !== null
}

/**
 * The on-device target to fall back on: the default entry's, when it
 * resolves on-device with its configured model, otherwise the first entry's
 * that does; `null` when none does.
 */
export function pickOnDeviceProvider(state: AiProvidersState): OnDeviceTarget | null {
  const preferred = defaultAiProvider(state)
  const candidates =
    preferred === null
      ? state.providers
      : [preferred, ...state.providers.filter((entry) => entry.id !== preferred.id)]
  for (const entry of candidates) {
    const target = resolveOnDeviceTarget(entry)
    if (target !== null) {
      return target
    }
  }
  return null
}

/** A refusal from {@link verifyOnDeviceServer}, with the reason to show. */
export interface OnDeviceServerRefusal {
  readonly kind: 'refused'
  readonly reason: string
}

/** What {@link verifyOnDeviceServer} concluded about the server behind a target. */
export type OnDeviceServerVerdict = 'ok' | OnDeviceServerRefusal

/**
 * Check the server behind `target` before content the cloud gate withholds
 * reaches it. For now a placeholder that answers `'ok'`: verification step
 * V1 (`docs/plans/27-on-device-models.md`) decides whether Ollama reports
 * cloud models through its API. If it does, this becomes a probe over
 * `onDeviceFetch` that refuses Ollama cloud models and fails closed when the
 * probe errors. Callers run it on every turn and run and never cache it.
 */
export async function verifyOnDeviceServer(
  _target: OnDeviceTarget,
): Promise<OnDeviceServerVerdict> {
  return 'ok'
}
