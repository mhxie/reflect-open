import { z } from 'zod'
import type { AssetOcrState } from '../../assets/asset-ocr-cache.ts'
import { readManagedDescription } from '../../assets/asset-description-helpers.ts'
import type { AssetPrivacyService } from '../../assets/asset-privacy-service.ts'
import type { XArchiveService } from '../../embeds/x-archive-service.ts'
import { isAppError } from '../../errors.ts'
import type { LocalOnlyFolders } from '../../graph/local-only.ts'
import type { DeviceNoteRead } from '../../graph/note-file-service.ts'
import { descriptionPathFor, isAssetPath, isAttachmentPath } from '../../graph/paths.ts'
import type { FileMeta } from '../../graph/schemas.ts'
import type { AssetReferences } from '../../indexing/asset-refs.ts'
import { attachmentReferenceCandidates, canonicalAssetPath } from '../../markdown/extract.ts'
import { splitFrontmatter } from '../../markdown/frontmatter.ts'
import { localSafeAssetDescription, type LocalSafe } from '../../privacy/local-checkers.ts'
import type { VerifiedModelTarget } from '../../privacy/on-device.ts'
import {
  isPrivateNoteError,
  notePrivate,
  type CloudAssetDescription,
  type CloudSafe,
  type PrivacyService,
} from '../../privacy/privacy-service.ts'

/**
 * The read_assets tool's executor (Plan 20 meets Plan 10): resolve an
 * `assets/…` path to its stored description sidecar (`<asset>.reflect.md`)
 * and gate it for the provider. The tool registration, name, and transcript
 * unions stay in `./note-tools-service` — this module only knows how to read
 * one asset. A verified on-device model also reads attachments outside
 * `assets/` and the device-only OCR text of the local cache.
 */

/**
 * Cap on assets one read_assets call returns, mirroring `MAX_READ_NOTES`.
 */
export const MAX_READ_ASSETS = 10

/**
 * Cap on one asset's returned description text — the same bound the indexer
 * puts on a note's folded asset text (`MAX_ASSET_TEXT_CHARS`), so the tool
 * never returns wildly more than search could have matched on.
 */
export const MAX_ASSET_DESCRIPTION_CHARS = 8_000

/**
 * read_assets miss — the sidecar description file doesn't exist (yet).
 */
export const NO_ASSET_DESCRIPTION_ERROR =
  'No description exists for this asset yet — descriptions are generated in the background.'

/**
 * read_assets refusal for a blocked asset. Deliberately unspecific: naming the
 * private reference would itself reveal that a private note exists, so the
 * private and unreferenced verdicts share one message.
 */
export const ASSET_UNAVAILABLE_ERROR = 'This asset cannot be read by AI.'

/**
 * read_assets refusal for a path that is not an `assets/` attachment.
 */
export const NOT_AN_ASSET_ERROR =
  'Not an asset path — pass assets/… paths exactly as they appear in note markdown.'

/**
 * read_assets refusal, on device, for a bare filename several attachments share.
 */
export const AMBIGUOUS_ASSET_ERROR =
  'Several attachments have this filename. Pass the full graph-relative path.'

/**
 * One asset in a {@link ReadAssetsOutput}: its stored description, or a structured miss/refusal.
 */
export type ReadAssetResult =
  | { ok: true; asset: CloudSafe<CloudAssetDescription> | LocalSafe<CloudAssetDescription> }
  | { ok: false; path: string; error: string }

/**
 * The read_assets output: one {@link ReadAssetResult} per requested path, in order.
 */
export interface ReadAssetsOutput {
  assets: ReadAssetResult[]
}

export const readAssetsInput = z.object({
  paths: z
    .array(z.string().min(1))
    .min(1)
    .max(MAX_READ_ASSETS)
    .describe(
      'Graph-relative asset paths as they appear in note markdown, e.g. ' +
        `["assets/photo.png"]. Pass every attachment you need in one call, up to ${MAX_READ_ASSETS}.`,
    ),
})

/**
 * The effects {@link buildReadOneAsset} needs.
 */
export interface ReadAssetDeps {
  /**
   * The tier's note reader for sidecars and referencing notes: it rejects a
   * local-only note (with `PrivateNoteError` for the cloud tier).
   */
  readNote: (path: string) => Promise<string>
  /**
   * The on-device tier's reader, which reports a local-only sidecar instead of refusing it.
   */
  readDeviceNote: (path: string) => Promise<DeviceNoteRead>
  /**
   * The graph's attachments, which resolve a bare filename on device.
   */
  listAttachments: () => Promise<FileMeta[]>
  /**
   * The device-only OCR state of an attachment (`assets/asset-ocr-cache.ts`).
   */
  readOcrState: (assetPath: string) => Promise<AssetOcrState | null>
  assetReferences: AssetReferences
  assetPrivacy: AssetPrivacyService
  xArchive: XArchiveService
  privacy: PrivacyService
  /**
   * The verified destination of the model the tools serve.
   */
  target: VerifiedModelTarget
  /**
   * The local-only folders of the graph the tools read.
   */
  localOnly: LocalOnlyFolders
}

/**
 * Build the per-asset reader for read_assets: the sidecar body (frontmatter
 * stripped, capped), or a structured per-asset miss/refusal. The model copies
 * paths verbatim from note markdown, so the href is first collapsed to the
 * canonical `assets/…` form the sidecar, index, and privacy gate all key off
 * (`./`-prefixes, percent-escapes). Existence is checked next — a missing
 * sidecar reveals nothing — then the live privacy verdict over the
 * referencing notes (the sidecar on disk can predate a note turning private)
 * gates the mint, failing closed. Once a sidecar exists, the verdict outranks
 * everything else about it — even an empty body answers "unavailable", not
 * "no description", when the asset is blocked.
 *
 * An attachment with device-only OCR is never readable by a cloud model; a
 * verified on-device model reads the OCR text, unless a user-authored
 * sidecar takes precedence, and a sticky invalidation hides an old managed
 * sidecar from both tiers.
 */
export function buildReadOneAsset(deps: ReadAssetDeps) {
  const onDevice = deps.target.kind === 'on-device' ? deps.target : null
  return async function readOneAsset(path: string): Promise<ReadAssetResult> {
    let canonical =
      onDevice !== null
        ? (attachmentReferenceCandidates('', path)[0] ?? null)
        : canonicalAssetPath(path)
    if (onDevice !== null && canonical !== null && !canonical.includes('/')) {
      const filename = canonical
      const matches = (await deps.listAttachments()).filter(
        (file) => file.path.split('/').at(-1) === filename,
      )
      if (matches.length > 1) {
        return { ok: false, path, error: AMBIGUOUS_ASSET_ERROR }
      }
      canonical = matches[0]?.path ?? canonical
    }
    if (
      canonical === null ||
      !(onDevice !== null ? isAttachmentPath(canonical) : isAssetPath(canonical))
    ) {
      return { ok: false, path, error: NOT_AN_ASSET_ERROR }
    }
    const cacheState = await deps.readOcrState(canonical)
    const cache = cacheState?.status === 'complete' ? cacheState : null
    if (onDevice === null && cacheState !== null) {
      return { ok: false, path, error: ASSET_UNAVAILABLE_ERROR }
    }
    let source: string | null = null
    let localOnly = false
    try {
      if (onDevice !== null) {
        const read = await deps.readDeviceNote(descriptionPathFor(canonical))
        source = read.content
        localOnly = read.localOnly
      } else {
        source = await deps.readNote(descriptionPathFor(canonical))
      }
    } catch (cause) {
      if (isAppError(cause) && cause.kind === 'notFound') {
        if (cache === null) {
          return { ok: false, path, error: NO_ASSET_DESCRIPTION_ERROR }
        }
      } else if (isPrivateNoteError(cause)) {
        return { ok: false, path, error: ASSET_UNAVAILABLE_ERROR }
      } else {
        throw cause
      }
    }
    if (
      cacheState?.status === 'invalid' &&
      source !== null &&
      readManagedDescription(source) !== null
    ) {
      return { ok: false, path, error: NO_ASSET_DESCRIPTION_ERROR }
    }
    const useCache = cache !== null && (source === null || readManagedDescription(source) !== null)
    const body = useCache ? cache.body : splitFrontmatter(source ?? '').body.trim()
    const owners = await deps.xArchive.owners(canonical)
    const candidates = await deps.assetReferences.notePaths(canonical, owners)
    const verdict = await deps.assetPrivacy.classifyAssetFromNotes(
      canonical,
      candidates,
      deps.readNote,
      owners,
    )
    const truncated = body.length > MAX_ASSET_DESCRIPTION_CHARS
    try {
      const content = {
        path: canonical,
        isPrivate:
          verdict !== 'send' || useCache || localOnly || (source !== null && notePrivate(source)),
        description: truncated ? body.slice(0, MAX_ASSET_DESCRIPTION_CHARS) : body,
        truncated,
      }
      const asset =
        onDevice !== null
          ? localSafeAssetDescription(deps.localOnly, onDevice, content)
          : deps.privacy.cloudSafeAssetDescription(content)
      if (body === '') {
        // An existing-but-empty sidecar reads as "no description" — but only
        // for a sendable asset; a blocked one threw above, so the two miss
        // messages stay consistent with the privacy contract.
        return { ok: false, path, error: NO_ASSET_DESCRIPTION_ERROR }
      }
      return { ok: true, asset }
    } catch (cause) {
      if (isPrivateNoteError(cause)) {
        return { ok: false, path, error: ASSET_UNAVAILABLE_ERROR }
      }
      throw cause
    }
  }
}
