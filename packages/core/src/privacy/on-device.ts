import { resolveChatModel, type ChatModelOption } from '../ai/chat/model-options.ts'
import {
  defaultAiProvider,
  withAiProviderAdded,
  withAiProviderOnDevice,
  type AiProvidersState,
} from '../ai/provider-config.ts'
import { normalizeOpenAICompatibleBaseUrl } from '../lib/http-url.ts'
import type {
  AiProviderConfig,
  HostedAiProviderConfig,
  OnDeviceServerKind,
  OpenAiCompatibleProviderConfig,
} from '../settings/schema.ts'
import { AppError } from '../errors.ts'
import { isLoopbackHttpUrl } from './loopback.ts'
import type { OnDeviceTarget } from './on-device-target.ts'
import type { OnDeviceServerVerdict } from './on-device-verification.ts'

/**
 * Which tier a resolved model belongs to. A model counts as running on this
 * Mac only when the user attested it: an OpenAI-compatible entry on a literal
 * loopback host whose `onDevice` attestation names exactly the endpoint and
 * model being called. Reflect can prove only that requests reach a loopback
 * socket (the transport in `ai/on-device-http-service.ts`); whether the server
 * keeps them there rests on that attestation. Everything else is cloud tier.
 *
 * The proof is a branded {@link OnDeviceTarget}, minted only here, holding a
 * frozen copy of the config it was minted for. Building the model from that
 * copy (`LanguageModelService.createFor`) means a target cannot be paired with
 * another entry, such as an undeclared tunnel on another loopback port.
 */

/**
 * Any other resolved model: content bound for it must pass the cloud gate.
 */
export interface CloudTarget {
  readonly kind: 'cloud'
  readonly config: Readonly<AiProviderConfig>
}

/**
 * Where a resolved model runs, as far as Reflect can tell.
 */
export type ModelTarget = OnDeviceTarget | CloudTarget

declare const verifiedOnDeviceBrand: unique symbol

/**
 * An attested model whose server passed the private-content check for this turn or action.
 */
export interface VerifiedOnDeviceTarget extends OnDeviceTarget {
  readonly [verifiedOnDeviceBrand]: true
}

/**
 * A cloud destination or an on-device destination verified before reading private content.
 */
export type VerifiedModelTarget = CloudTarget | VerifiedOnDeviceTarget

/**
 * Verify a turn's destination before any private content is read: a cloud
 * target passes as it is, an on-device target only once `verifyServer`
 * (`OnDeviceModelService.verifyServer`) accepts its server. A refusal throws
 * `AppError('auth', reason)`; it never falls back to cloud.
 */
export async function verifyModelTarget(
  target: ModelTarget,
  verifyServer: (target: OnDeviceTarget) => Promise<OnDeviceServerVerdict>,
): Promise<VerifiedModelTarget> {
  if (target.kind === 'cloud') {
    return target
  }
  const verdict = await verifyServer(target)
  if (verdict !== 'ok') {
    throw new AppError('auth', verdict.reason)
  }
  // The brand has no runtime representation, so this assertion is the whole
  // verification mint; the guarantee is the accepted verdict above.
  return target as VerifiedOnDeviceTarget
}

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

/**
 * The one place an {@link OnDeviceTarget} is born. Private by design.
 */
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
 * The cloud target of a hosted provider entry: a frozen copy of its config.
 * Hosted providers never run on this Mac.
 */
export function cloudTarget(config: HostedAiProviderConfig): CloudTarget {
  const cloud: CloudTarget = { kind: 'cloud', config: Object.freeze({ ...config }) }
  return Object.freeze(cloud)
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

/**
 * The providers state with an OpenAI-compatible entry attested for `model`
 * at the loopback `baseUrl`, and that entry's id: an entry already attested
 * for exactly this base URL and model is used as it is; else an entry at this
 * base URL with this model is attested; else a keyless entry is added (the
 * default only when it is the first). No other entry changes, so no other
 * feature's model or attestation moves. Call it once the user has confirmed
 * the attestation.
 */
export function withOnDeviceModel(
  state: AiProvidersState,
  baseUrl: string,
  model: string,
  server: OnDeviceServerKind,
  newId: () => string,
): { state: AiProvidersState; id: string } {
  const url = normalizeOpenAICompatibleBaseUrl(baseUrl)
  const sameModel = state.providers.filter(
    (entry) =>
      entry.provider === 'openai-compatible' &&
      normalizeOpenAICompatibleBaseUrl(entry.baseUrl) === url &&
      entry.model === model,
  )
  const attested = sameModel.find((entry) => resolveOnDeviceTarget(entry) !== null)
  if (attested !== undefined) {
    return { state, id: attested.id }
  }
  const existing = sameModel[0]
  if (existing !== undefined) {
    const providers = withAiProviderOnDevice(state.providers, existing.id, true, server)
    return { state: { ...state, providers }, id: existing.id }
  }
  const id = newId()
  const added = withAiProviderAdded(
    state,
    { id, provider: 'openai-compatible', model, baseUrl: url, keyHint: '' },
    false,
  )
  const providers = withAiProviderOnDevice(added.providers, id, true, server)
  return { state: { ...added, providers }, id }
}
