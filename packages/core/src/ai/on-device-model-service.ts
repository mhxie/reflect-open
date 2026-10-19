import {
  verifyModelTarget,
  type ModelTarget,
  type VerifiedModelTarget,
} from '../privacy/on-device.ts'
import type { OnDeviceTarget } from '../privacy/on-device-target.ts'
import {
  verifyOnDeviceServer,
  type OnDeviceServerVerdict,
  type OnDeviceVerificationOptions,
} from '../privacy/on-device-verification.ts'
import type { OnDeviceHttpService } from './on-device-http-service.ts'
import {
  listOllamaModels,
  type ListOllamaModelsOptions,
  type OllamaModels,
} from './ollama-models.ts'

/**
 * The models running on this Mac (fork: on-device AI): the check that
 * clears an attested model's server before private content is read, and the
 * Ollama install the summary model picker offers. Every request goes over
 * the loopback-only transport.
 */
export interface OnDeviceModelService {
  /**
   * Verify a turn's or an action's destination before any private content is
   * read: a cloud target passes as it is, an on-device target only once
   * {@link OnDeviceModelService.verifyServer} accepts its server. A refusal
   * rejects with `AppError('auth', reason)`; it never falls back to cloud.
   */
  verify(target: ModelTarget, apiKey: string, signal?: AbortSignal): Promise<VerifiedModelTarget>
  /**
   * Check the server behind `target`: Ollama's version and the exact model's
   * `/api/show` metadata, refusing cloud models, remote aliases and failed
   * probes; a generic OpenAI-compatible server only with its explicit
   * attestation and a 404 version endpoint.
   */
  verifyServer(
    target: OnDeviceTarget,
    options?: OnDeviceVerificationOptions,
  ): Promise<OnDeviceServerVerdict>
  /**
   * The models installed in the Ollama server on this Mac that can write a
   * summary, sorted by name; cloud and embedding-only models are left out.
   */
  listOllamaModels(options?: ListOllamaModelsOptions): Promise<OllamaModels>
}

export interface OnDeviceModelServiceDeps {
  readonly onDeviceHttp: OnDeviceHttpService
}

class OnDeviceModelServiceImpl implements OnDeviceModelService {
  readonly #deps: OnDeviceModelServiceDeps

  constructor(deps: OnDeviceModelServiceDeps) {
    this.#deps = deps
  }

  async verify(
    target: ModelTarget,
    apiKey: string,
    signal?: AbortSignal,
  ): Promise<VerifiedModelTarget> {
    return await verifyModelTarget(target, (onDevice) => {
      return this.verifyServer(onDevice, { apiKey, signal })
    })
  }

  async verifyServer(
    target: OnDeviceTarget,
    options?: OnDeviceVerificationOptions,
  ): Promise<OnDeviceServerVerdict> {
    return await verifyOnDeviceServer(this.#deps.onDeviceHttp, target, options)
  }

  async listOllamaModels(options?: ListOllamaModelsOptions): Promise<OllamaModels> {
    return await listOllamaModels(this.#deps.onDeviceHttp, options)
  }
}

export function createOnDeviceModelService(deps: OnDeviceModelServiceDeps): OnDeviceModelService {
  return new OnDeviceModelServiceImpl(deps)
}
