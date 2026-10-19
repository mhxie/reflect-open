import { bytesToBase64 } from '@reflect/utils'
import type { AiCredentialService } from '../ai/ai-credential-service.ts'
import type { AiProviderConfigService } from '../ai/ai-provider-config-service.ts'
import {
  isAssetDescriptionRejected,
  type AssetDescriberService,
} from '../ai/asset-describer-service.ts'
import type { LanguageModelService } from '../ai/language-model-service.ts'
import type { OnDeviceModelService } from '../ai/on-device-model-service.ts'
import { errorMessage, isAppError, ReflectError, toAppError } from '../errors.ts'
import type { AssetStoreService } from '../graph/asset-store-service.ts'
import type { NoteFileService } from '../graph/note-file-service.ts'
import { descriptionPathFor } from '../graph/paths.ts'
import type { FileMeta } from '../graph/schemas.ts'
import type { DatabaseService } from '../indexing/database-service.ts'
import { hashBytes } from '../indexing/hash.ts'
import type { ClockService } from '../ports/clock-service.ts'
import { modelTarget } from '../privacy/on-device.ts'
import { localOcrAssetTypeFor, readManagedDescription } from './asset-description-helpers.ts'
import type {
  ReconcileAssetDescriptionsInput,
  ReconcileAssetDescriptionsOutcome,
} from './asset-description-types.ts'
import { MAX_LOCAL_OCR_CHARS, readLocalAssetOcr, writeLocalAssetOcr } from './asset-ocr-cache.ts'

/**
 * Most pages read from one PDF; a longer document is skipped as oversize.
 */
const MAX_OCR_PAGES = 100

/**
 * One local OCR pass: {@link ReconcileAssetDescriptionsInput} with the
 * explicitly selected on-device vision provider.
 */
export interface ReconcileLocalAssetOcrInput extends ReconcileAssetDescriptionsInput {
  /**
   * The selected on-device vision provider entry. A missing or invalid
   * selection stops the pass; it never falls back to another provider.
   */
  localOcrProviderId: string
}

export interface LocalAssetOcrServiceDeps {
  readonly assetStore: AssetStoreService
  readonly noteFile: NoteFileService
  readonly database: DatabaseService
  readonly aiProviderConfig: AiProviderConfigService
  readonly aiCredentials: AiCredentialService
  readonly onDeviceModels: OnDeviceModelService
  readonly languageModel: LanguageModelService
  readonly assetDescriber: AssetDescriberService
  readonly clock: ClockService
}

/**
 * Text recognition of attachments with a verified on-device vision model, the
 * private sibling of the AI descriptions: every referenced image and PDF,
 * private notes and local-only folders included, is read on this device,
 * recognized by the model the user selected, and stored only in the
 * device-only OCR cache (`asset-ocr-cache.ts`), never in a synced sidecar.
 * Nothing is sent anywhere else: the model must be attested on-device and
 * verified before the first byte is read.
 */
export interface LocalAssetOcrService {
  /**
   * Recognize every candidate attachment that lacks a current result (see
   * `AssetDescriptionService.reconcile`, whose outcome it reports in). A
   * failure confined to one attachment (oversize, offline, unreadable,
   * refused, blank) is tallied and the pass goes on; credentials, the server,
   * a stale graph and anything unrecognized stop the pass. Never throws.
   */
  reconcile(input: ReconcileLocalAssetOcrInput): Promise<ReconcileAssetDescriptionsOutcome>
}

function emptyOutcome(): ReconcileAssetDescriptionsOutcome {
  return {
    pending: 0,
    described: 0,
    skippedUpToDate: 0,
    skippedUnreferenced: 0,
    skippedPrivate: 0,
    skippedUserAuthored: 0,
    skippedChanged: 0,
    skippedOversize: 0,
    refused: 0,
    describedAssetPaths: [],
    stopped: null,
  }
}

/**
 * The listed modification time of `path` for the cache, when the listing's
 * size agrees with the bytes read (otherwise the file changed in between and
 * the time can't vouch for those bytes).
 */
function sourceModifiedMs(
  catalog: readonly FileMeta[],
  path: string,
  size: number,
): { sourceModifiedMs?: number } {
  const meta = catalog.find((file) => file.path === path)
  return meta !== undefined && meta.placeholder !== true && meta.size === size
    ? { sourceModifiedMs: meta.modifiedMs }
    : {}
}

/**
 * The outcome counters a failure confined to one asset is tallied under.
 */
type AssetSkipTally = 'skippedOversize' | 'skippedUnreferenced' | 'refused'

/**
 * Where a failure confined to one asset is tallied, or `null` when it must
 * stop the whole pass. An oversize, offline, unreadable or changed source, a
 * PDF the engine can't open, and a model answer that is empty or refused all
 * concern that one asset: the pass skips it and goes on. Credentials, the
 * server (network), a stale graph and anything unrecognized stop the pass, so
 * the next trigger retries the batch.
 */
function assetSkipTally(cause: unknown): AssetSkipTally | null {
  if (isAssetDescriptionRejected(cause)) {
    return 'refused'
  }
  if (!isAppError(cause)) {
    return null
  }
  switch (cause.kind) {
    case 'unsupported':
      return 'skippedOversize'
    case 'notFound':
      return 'skippedUnreferenced'
    case 'io':
    case 'invalid':
    case 'locked':
    case 'parse':
    case 'traversal':
      return 'refused'
    default:
      return null
  }
}

function basename(path: string): string {
  return path.split('/').at(-1) ?? path
}

class LocalAssetOcrServiceImpl implements LocalAssetOcrService {
  readonly #deps: LocalAssetOcrServiceDeps

  constructor(deps: LocalAssetOcrServiceDeps) {
    this.#deps = deps
  }

  async reconcile(input: ReconcileLocalAssetOcrInput): Promise<ReconcileAssetDescriptionsOutcome> {
    const {
      assetStore,
      noteFile,
      database,
      aiProviderConfig,
      aiCredentials,
      onDeviceModels,
      languageModel,
      assetDescriber,
      clock,
    } = this.#deps
    const outcome = emptyOutcome()
    const stale = (): void => {
      if (input.isStale?.() === true) {
        throw new ReflectError('noGraph', 'The graph session ended during local OCR.')
      }
    }
    try {
      const support = await assetStore.localOcrSupport(input.generation)
      if (!support.cache) {
        outcome.stopped = {
          reason: 'unsupported',
          message: 'Local OCR is currently supported on macOS and Linux.',
        }
        return outcome
      }
      const config = aiProviderConfig.list().find((entry) => entry.id === input.localOcrProviderId)
      if (
        config === undefined ||
        config.provider !== 'openai-compatible' ||
        !config.supportsImages
      ) {
        outcome.stopped = {
          reason: 'config',
          message: 'Select an on-device vision model for local OCR.',
        }
        return outcome
      }
      const target = modelTarget(config)
      if (target.kind !== 'on-device') {
        outcome.stopped = {
          reason: 'config',
          message: 'The selected OCR model needs a current on-device attestation.',
        }
        return outcome
      }
      const apiKey = await aiCredentials.read(config)
      if (apiKey === null) {
        throw new ReflectError('auth', 'The selected local OCR model is missing its API key.')
      }
      const verified = await onDeviceModels.verify(target, apiKey)
      if (verified.kind !== 'on-device') {
        throw new ReflectError('auth', 'Local OCR requires a verified on-device model.')
      }
      stale()
      const model = await languageModel.createFor(verified, apiKey)
      const rows = await database.db.selectFrom('assets').select('assetPath').distinct().execute()
      const referenced = new Set(rows.map((row) => row.assetPath))
      const catalog = await noteFile.listAttachments(input.generation)
      const requested = input.mode === 'backfill' ? [...referenced] : (input.changed ?? [])
      const candidates = [
        ...new Set(
          requested.flatMap((path) =>
            path.includes('/')
              ? path
              : catalog.filter((file) => basename(file.path) === path).map((file) => file.path),
          ),
        ),
      ].filter((path) => localOcrAssetTypeFor(path) !== null)
      outcome.pending = candidates.length
      for (const [index, path] of candidates.entries()) {
        stale()
        try {
          if (!referenced.has(path) && !referenced.has(basename(path))) {
            outcome.skippedUnreferenced += 1
            continue
          }
          if (await this.#hasUserDescription(path, input.generation)) {
            outcome.skippedUserAuthored += 1
            continue
          }
          stale()
          const type = localOcrAssetTypeFor(path)
          if (type === null) {
            continue
          }
          if (type.kind === 'pdf' && !support.pdf) {
            outcome.skippedOversize += 1
            continue
          }
          const bytes = await assetStore.readBytesForDevice(path, input.generation)
          const sourceHash = await hashBytes(bytes)
          const cached = await readLocalAssetOcr(assetStore, path, input.generation)
          if (
            cached?.sourceHash === sourceHash &&
            cached.providerId === config.id &&
            cached.model === config.model &&
            cached.baseUrl === config.baseUrl
          ) {
            outcome.skippedUpToDate += 1
            continue
          }
          stale()
          const pages =
            type.kind === 'pdf'
              ? (await assetStore.pdfInfoForDevice(path, input.generation, sourceHash)).pages.length
              : 1
          if (pages === 0 || pages > MAX_OCR_PAGES) {
            outcome.skippedOversize += 1
            continue
          }
          const sections: string[] = []
          let characters = 0
          for (let page = 1; page <= pages; page += 1) {
            stale()
            const pageBytes =
              type.kind === 'pdf'
                ? await assetStore.readPdfPageForDevice(path, page, input.generation, sourceHash)
                : bytes
            stale()
            const body = await assetDescriber.describe({
              config,
              apiKey,
              localModel: model,
              kind: type.kind === 'pdf' ? 'image' : type.kind,
              mediaType: type.kind === 'pdf' ? 'image/png' : type.mediaType,
              data:
                type.kind === 'svg'
                  ? new TextDecoder().decode(pageBytes)
                  : bytesToBase64(pageBytes),
              filename: `${basename(path)}${type.kind === 'pdf' ? ` — page ${page}` : ''}`,
            })
            if (body.trim() === '') {
              // A blank page or image: no complete result to cache.
              throw new ReflectError('invalid', 'The local vision model returned empty OCR text.')
            }
            const section = type.kind === 'pdf' ? `## Page ${page}\n\n${body}` : body
            characters += section.length + 2
            if (characters > MAX_LOCAL_OCR_CHARS) {
              throw new ReflectError(
                'unsupported',
                'OCR text exceeds 200,000 characters; no partial result was cached.',
              )
            }
            sections.push(section)
          }
          stale()
          const currentHash = await hashBytes(
            await assetStore.readBytesForDevice(path, input.generation),
          )
          if (
            currentHash !== sourceHash ||
            (await this.#hasUserDescription(path, input.generation))
          ) {
            outcome.skippedChanged += 1
            continue
          }
          stale()
          await writeLocalAssetOcr(
            assetStore,
            {
              version: 1,
              status: 'complete',
              deviceOnly: true,
              assetPath: path,
              sourceHash,
              sourceSize: bytes.length,
              ...sourceModifiedMs(catalog, path, bytes.length),
              providerId: config.id,
              model: config.model,
              baseUrl: config.baseUrl,
              pages,
              generatedAt: new Date(clock.now()).toISOString(),
              body: sections.join('\n\n'),
            },
            input.generation,
          )
          stale()
          outcome.described += 1
          outcome.describedAssetPaths.push(path)
        } catch (cause) {
          const tally = input.isStale?.() === true ? null : assetSkipTally(cause)
          if (tally === null) {
            throw cause
          }
          outcome[tally] += 1
        } finally {
          if (input.isStale?.() !== true) {
            input.onProgress?.(index + 1, candidates.length)
          }
        }
      }
    } catch (cause) {
      outcome.stopped = {
        reason: input.isStale?.() === true ? 'stale' : toAppError(cause).kind,
        message: errorMessage(cause),
      }
    }
    return outcome
  }

  /**
   * Whether a user-authored description sidecar sits next to `path`: the
   * user's own text about the asset is never shadowed by recognized text.
   */
  async #hasUserDescription(path: string, generation: number): Promise<boolean> {
    try {
      const source = await this.#deps.noteFile.readForDevice(descriptionPathFor(path), generation)
      return readManagedDescription(source.content) === null
    } catch (cause) {
      if (isAppError(cause) && cause.kind === 'notFound') {
        return false
      }
      throw cause
    }
  }
}

export function createLocalAssetOcrService(deps: LocalAssetOcrServiceDeps): LocalAssetOcrService {
  return new LocalAssetOcrServiceImpl(deps)
}
