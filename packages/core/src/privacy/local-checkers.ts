import type {
  CloudAssetDescription,
  CloudNoteContent,
  CloudNoteListing,
  CloudSearchHit,
  CloudSendable,
} from './checkers.ts'
import { isLocalOnlyPath } from '../graph/local-only.ts'
import type { VerifiedOnDeviceTarget } from './on-device.ts'

declare const localSafeBrand: unique symbol

/** A value bound to a verified on-device model, with persisted private-context provenance. */
export type LocalSafe<T> = T & {
  readonly [localSafeBrand]: true
  readonly reflectPrivateContext?: true
}

function mint<T>(_target: VerifiedOnDeviceTarget, value: T, isPrivate: boolean): LocalSafe<T> {
  return (isPrivate ? { ...value, reflectPrivateContext: true } : value) as LocalSafe<T>
}

/** Bind a search hit to an on-device target, retaining private snippets and provenance. */
export function localSafeSearchHit(
  target: VerifiedOnDeviceTarget,
  hit: CloudSearchHit & CloudSendable,
): LocalSafe<CloudSearchHit> {
  return mint(
    target,
    {
      path: hit.path,
      title: hit.title,
      snippet: hit.snippet,
      heading: hit.heading,
      ...(hit.assetTextHash === undefined ? {} : { assetTextHash: hit.assetTextHash }),
    },
    hit.isPrivate ||
      hit.hasDeviceOnlyContent === true ||
      isLocalOnlyPath(hit.path) ||
      hit.assetTextHash === undefined,
  )
}

/** Bind a listing to an on-device target, retaining private metadata and provenance. */
export function localSafeNoteListing(
  target: VerifiedOnDeviceTarget,
  entry: CloudNoteListing & CloudSendable,
): LocalSafe<CloudNoteListing> {
  return mint(
    target,
    {
      path: entry.path,
      title: entry.title,
      dailyDate: entry.dailyDate,
      snippet: entry.snippet,
      modifiedAt: entry.modifiedAt,
    },
    entry.isPrivate || isLocalOnlyPath(entry.path),
  )
}

/** Bind live note content to an on-device target and mark any private source. */
export function localSafeNoteContent(
  target: VerifiedOnDeviceTarget,
  note: CloudNoteContent & CloudSendable,
): LocalSafe<CloudNoteContent> {
  return mint(
    target,
    { path: note.path, title: note.title, content: note.content, truncated: note.truncated },
    note.isPrivate || isLocalOnlyPath(note.path),
  )
}

/** Bind attachment text to an on-device target, including device-only OCR provenance. */
export function localSafeAssetDescription(
  target: VerifiedOnDeviceTarget,
  asset: CloudAssetDescription & CloudSendable,
): LocalSafe<CloudAssetDescription> {
  return mint(
    target,
    { path: asset.path, description: asset.description, truncated: asset.truncated },
    asset.isPrivate || isLocalOnlyPath(asset.path),
  )
}
