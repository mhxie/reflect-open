import { describeAsset } from '../ai/describe-asset.ts'
import { languageModelFor } from '../ai/language-model.ts'
import { aiApiKeyForConfig } from '../ai/secrets.ts'
import { errorMessage, isAppError, ReflectError, toAppError } from '../errors.ts'
import {
  listAttachments,
  pdfInfoForDevice,
  localOcrSupported,
  readAssetForDevice,
  readNoteForDevice,
  readPdfPageForDevice,
} from '../graph/commands.ts'
import { descriptionPathFor } from '../graph/paths.ts'
import { db } from '../indexing/db.ts'
import { hashBytes } from '../indexing/hash.ts'
import { bytesToBase64 } from '../lib/base64.ts'
import { modelTarget, verifyModelTarget } from '../privacy/on-device.ts'
import { readManagedDescription, localOcrAssetTypeFor } from './asset-description-helpers.ts'
import { MAX_LOCAL_OCR_CHARS, readLocalAssetOcr, writeLocalAssetOcr } from './asset-ocr-cache.ts'
import type {
  ReconcileAssetDescriptionsInput,
  ReconcileAssetDescriptionsOutcome,
} from './asset-description.ts'

const MAX_OCR_PAGES = 100

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

async function hasUserDescription(path: string, generation: number): Promise<boolean> {
  try {
    const source = await readNoteForDevice(descriptionPathFor(path), generation)
    return readManagedDescription(source.content) === null
  } catch (cause) {
    if (isAppError(cause) && cause.kind === 'notFound') {
      return false
    }
    throw cause
  }
}

/** OCR indexed attachments with the explicitly selected, verified local vision model. */
export async function reconcileLocalAssetOcr(
  input: ReconcileAssetDescriptionsInput,
  providerId: string,
): Promise<ReconcileAssetDescriptionsOutcome> {
  const outcome = emptyOutcome()
  const stale = (): void => {
    if (input.isStale?.() === true) {
      throw new ReflectError('noGraph', 'The graph session ended during local OCR.')
    }
  }
  try {
    if (!(await localOcrSupported(input.generation))) {
      outcome.stopped = {
        reason: 'unsupported',
        message: 'Local OCR is currently supported on macOS and Linux.',
      }
      return outcome
    }
    const config = input.providers.providers.find((entry) => entry.id === providerId)
    if (config === undefined || config.provider !== 'openai-compatible' || !config.supportsImages) {
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
    const apiKey = await aiApiKeyForConfig(config)
    if (apiKey === null) {
      throw new ReflectError('auth', 'The selected local OCR model is missing its API key.')
    }
    const verified = await verifyModelTarget(target, apiKey)
    if (verified.kind !== 'on-device') {
      throw new ReflectError('auth', 'Local OCR requires a verified on-device model.')
    }
    stale()
    const model = await languageModelFor(verified, apiKey, input.fetchFn ?? fetch)
    const rows = await db.selectFrom('assets').select('assetPath').distinct().execute()
    const referenced = new Set(rows.map((row) => row.assetPath))
    const catalog = await listAttachments(input.generation)
    const requested = input.mode === 'backfill' ? [...referenced] : (input.changed ?? [])
    const candidates = [
      ...new Set(
        requested.flatMap((path) =>
          path.includes('/')
            ? path
            : catalog
                .filter((file) => file.path.split('/').at(-1) === path)
                .map((file) => file.path),
        ),
      ),
    ].filter((path) => localOcrAssetTypeFor(path) !== null)
    outcome.pending = candidates.length
    for (const [index, path] of candidates.entries()) {
      stale()
      try {
        if (!referenced.has(path) && !referenced.has(path.split('/').at(-1) ?? path)) {
          outcome.skippedUnreferenced += 1
          continue
        }
        if (await hasUserDescription(path, input.generation)) {
          outcome.skippedUserAuthored += 1
          continue
        }
        stale()
        const type = localOcrAssetTypeFor(path)
        if (type === null) {
          continue
        }
        let bytes: Uint8Array<ArrayBuffer>
        try {
          bytes = await readAssetForDevice(path, input.generation)
        } catch (cause) {
          if (isAppError(cause) && cause.kind === 'notFound') {
            outcome.skippedUnreferenced += 1
            continue
          }
          throw cause
        }
        const sourceHash = await hashBytes(bytes)
        const cached = await readLocalAssetOcr(path, input.generation)
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
            ? (await pdfInfoForDevice(path, input.generation, sourceHash)).pages.length
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
              ? await readPdfPageForDevice(path, page, input.generation, sourceHash)
              : bytes
          stale()
          const body = await describeAsset({
            config,
            apiKey,
            localModel: model,
            kind: type.kind === 'pdf' ? 'image' : type.kind,
            mediaType: type.kind === 'pdf' ? 'image/png' : type.mediaType,
            data:
              type.kind === 'svg' ? new TextDecoder().decode(pageBytes) : bytesToBase64(pageBytes),
            filename: `${path.split('/').at(-1) ?? path}${type.kind === 'pdf' ? ` — page ${page}` : ''}`,
          })
          if (body.trim() === '') {
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
        const currentHash = await hashBytes(await readAssetForDevice(path, input.generation))
        if (currentHash !== sourceHash || (await hasUserDescription(path, input.generation))) {
          outcome.skippedChanged += 1
          continue
        }
        stale()
        await writeLocalAssetOcr(
          {
            version: 1,
            status: 'complete',
            deviceOnly: true,
            assetPath: path,
            sourceHash,
            sourceSize: bytes.length,
            providerId: config.id,
            model: config.model,
            baseUrl: config.baseUrl,
            pages,
            generatedAt: (input.now?.() ?? new Date()).toISOString(),
            body: sections.join('\n\n'),
          },
          input.generation,
        )
        stale()
        outcome.described += 1
        outcome.describedAssetPaths.push(path)
      } finally {
        if (input.isStale?.() !== true) input.onProgress?.(index + 1, candidates.length)
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
