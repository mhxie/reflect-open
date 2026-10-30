import type { RetrievalHit } from '../embeddings/retrieval-hit.ts'
import type { GraphSessionSource } from '../graph/graph-session.ts'
import { isLocalOnlyPath, type LocalOnlyFolders } from '../graph/local-only.ts'
import type { NoteFileService } from '../graph/note-file-service.ts'
import { frontmatterPrivacy } from '../markdown/frontmatter.ts'
import type { CloudSafe } from './cloud-safe.ts'

/**
 * Reflect's outbound-service privacy gate (Plan 10). `private: true` is a hard block:
 * a private note's content must never be sent to an external service. A note
 * inside a local-only folder (`../graph/local-only.ts`) is private by its
 * path, whatever its frontmatter says — every gate here checks both.
 *
 * Enforcement is structural, not call-site discipline: provider-bound
 * payloads carry note content only as {@link CloudSafe} values, and the
 * *only* constructors for `CloudSafe` live in this module, where the privacy
 * checks run. An unchecked payload can't be built: adding a new outbound
 * integration means minting its content here or it won't typecheck.
 */

/**
 * The one place a `CloudSafe` is born. Private by design.
 */
function mint<T>(value: T): CloudSafe<T> {
  // The brand has no runtime representation, so this assertion is the
  // entire implementation — the guarantees live in the callers below.
  return value as CloudSafe<T>
}

/**
 * What the cloud guard needs to know about a note.
 */
export interface CloudSendable {
  /**
   * Graph-relative path: checked against the local-only folders, and named in the error.
   */
  path: string
  /**
   * The note's live privacy flag: `private: true`, or frontmatter that can't
   * be read and so counts as locked (see {@link notePrivate}).
   */
  isPrivate: boolean
  /**
   * Device-only derivations in an indexed search snapshot.
   */
  hasDeviceOnlyContent?: boolean
}

/**
 * Whether a note may not leave the device: flagged private, carrying
 * device-only derivations, or local-only by its path in `localOnly`, the open
 * graph's folders. Every cloud gate and on-device provenance marker decides
 * with this one predicate.
 */
export function isPrivateNote(localOnly: LocalOnlyFolders, note: CloudSendable): boolean {
  return (
    note.isPrivate || note.hasDeviceOnlyContent === true || isLocalOnlyPath(localOnly, note.path)
  )
}

/**
 * Thrown when a private note would otherwise reach an external service.
 */
export class PrivateNoteError extends Error {
  constructor(path: string) {
    super(`"${path}" is marked private and cannot be sent to an external service`)
    this.name = 'PrivateNoteError'
  }
}

/**
 * Type guard for {@link PrivateNoteError} across module boundaries.
 */
export function isPrivateNoteError(value: unknown): value is PrivateNoteError {
  return value instanceof Error && value.name === 'PrivateNoteError'
}

/**
 * Assert that `note`'s content may leave the device, given the open graph's
 * local-only folders. Throws {@link PrivateNoteError} when the note is
 * private ({@link isPrivateNote}) — callers either let the refusal propagate
 * or turn it into a structured "this note is private" answer, but they can
 * never accidentally ship the body.
 */
export function assertCloudAllowed(localOnly: LocalOnlyFolders, note: CloudSendable): void {
  if (isPrivateNote(localOnly, note)) {
    throw new PrivateNoteError(note.path)
  }
}

/**
 * Gate a link destination before local metadata lookup performs any outbound
 * request on behalf of a note.
 */
export function cloudSafeLinkHref(
  localOnly: LocalOnlyFolders,
  note: CloudSendable,
  href: string,
): CloudSafe<string> {
  assertCloudAllowed(localOnly, note)
  return mint(href)
}

/**
 * Whether a note's own frontmatter keeps it on the device, from its full
 * markdown source: locked, or unreadable and so treated as locked (the shared
 * fail-closed classifier, `frontmatter-privacy.ts`).
 */
export function notePrivate(source: string): boolean {
  return frontmatterPrivacy(source).kind !== 'public'
}

/**
 * One search hit as an external service may see it.
 */
export interface CloudSearchHit {
  path: string
  title: string
  snippet: string
  heading: string | null
  /**
   * Persisted attachment-text identity for subsequent history privacy checks.
   */
  assetTextHash?: string
}

/**
 * Gate retrieval hits for an outbound payload: private hits are dropped
 * **entirely** — even a bare title is a leak — and so is a hit without the
 * attachment-text identity of its snapshot; the rest are stripped to the
 * cloud-facing fields. Every surviving hit is re-checked through
 * `isPrivateLive`, which must fail closed.
 */
async function searchHitsWithProbe(
  localOnly: LocalOnlyFolders,
  hits: readonly RetrievalHit[],
  isPrivateLive: (hit: RetrievalHit) => Promise<boolean>,
): Promise<CloudSafe<CloudSearchHit>[]> {
  const indexedPublic = hits.filter(
    (hit) => !isPrivateNote(localOnly, hit) && hit.assetTextHash !== undefined,
  )
  const liveFlags = await Promise.all(indexedPublic.map((hit) => isPrivateLive(hit)))
  return indexedPublic
    .filter((_, index) => liveFlags[index] === false)
    .map((hit) => {
      return mint({
        path: hit.path,
        title: hit.title,
        snippet: hit.snippet,
        heading: hit.heading,
        ...(hit.assetTextHash === undefined ? {} : { assetTextHash: hit.assetTextHash }),
      })
    })
}

/**
 * One note-listing entry as an external service may see it.
 */
export interface CloudNoteListing {
  path: string
  title: string
  /**
   * ISO `YYYY-MM-DD` when the note is a daily note, `null` otherwise.
   */
  dailyDate: string | null
  /**
   * The indexed row preview (may be empty).
   */
  snippet: string
  /**
   * Last file modification, ISO 8601 UTC.
   */
  modifiedAt: string
}

async function noteListingsWithProbe(
  localOnly: LocalOnlyFolders,
  entries: readonly (CloudSendable & Omit<CloudNoteListing, 'path'>)[],
  isPrivateLive: (path: string) => Promise<boolean>,
): Promise<CloudSafe<CloudNoteListing>[]> {
  const indexedPublic = entries.filter((entry) => !isPrivateNote(localOnly, entry))
  const liveFlags = await Promise.all(indexedPublic.map((entry) => isPrivateLive(entry.path)))
  return indexedPublic
    .filter((_, index) => liveFlags[index] === false)
    .map((entry) => {
      return mint({
        path: entry.path,
        title: entry.title,
        dailyDate: entry.dailyDate,
        snippet: entry.snippet,
        modifiedAt: entry.modifiedAt,
      })
    })
}

/**
 * The graph-level prompt context as an external service may see it.
 */
export interface CloudGraphContext {
  /**
   * The graph's display name (its root folder name).
   */
  graphName: string
  /**
   * Non-daily notes the assistant can list or read.
   */
  noteCount: number
  /**
   * Days with a daily note.
   */
  dailyNoteCount: number
  /**
   * ISO date of the first daily note, `null` when there are none.
   */
  earliestDailyDate: string | null
  /**
   * ISO date of the latest daily note, `null` when there are none.
   */
  latestDailyDate: string | null
  /**
   * Tag facets, most-used first.
   */
  tags: { tag: string; count: number }[]
  /**
   * The facet list was capped — more tags exist.
   */
  tagsTruncated: boolean
}

/**
 * Gate the graph-level stats block for the system prompt. Unlike the
 * per-note gates there is nothing to re-check live: these are aggregates
 * with no note identity attached, so privacy rests on the **queries** —
 * callers must compute every figure over `is_private = 0` rows only
 * (`loadGraphStats` does). The index-lag window the live probes close
 * elsewhere (a note marked private moments before reindex) is accepted
 * here: no title, path, or content can leak through an aggregate — at
 * worst a tag name that was public seconds earlier is still counted.
 */
export function cloudSafeGraphContext(context: CloudGraphContext): CloudSafe<CloudGraphContext> {
  return mint(context)
}

/**
 * A note's content as an external service may see it.
 */
export interface CloudNoteContent {
  path: string
  title: string
  content: string
  truncated: boolean
}

/**
 * Gate one note's content for an outbound payload. Callers pass the **live**
 * privacy flag (re-read from the file at call time — the index can be stale
 * right after the user marks a note private) and the open graph's local-only
 * folders; a private note throws {@link PrivateNoteError} before any content
 * is minted.
 */
export function cloudSafeNoteContent(
  localOnly: LocalOnlyFolders,
  note: CloudSendable & Omit<CloudNoteContent, 'path'>,
): CloudSafe<CloudNoteContent> {
  assertCloudAllowed(localOnly, note)
  return mint({
    path: note.path,
    title: note.title,
    content: note.content,
    truncated: note.truncated,
  })
}

/**
 * One asset's stored description as an external service may see it.
 */
export interface CloudAssetDescription {
  /**
   * Graph-relative asset path, e.g. `assets/photo.png`.
   */
  path: string
  /**
   * The description file's markdown body (frontmatter stripped, capped).
   */
  description: string
  truncated: boolean
}

/**
 * Gate one asset's stored description (Plan 20's `<asset>.reflect.md`) for an
 * outbound payload. Callers pass the asset's **live** privacy verdict as
 * `isPrivate` — sendable only when the asset is referenced by ≥1 public note
 * and 0 private notes, decided from each referencing note's markdown at call
 * time (`classifyAssetFromNotes`), because the sidecar on disk can predate a
 * note turning private. A blocked asset throws {@link PrivateNoteError}
 * before any description text is minted.
 */
export function cloudSafeAssetDescription(
  localOnly: LocalOnlyFolders,
  asset: CloudSendable & Omit<CloudAssetDescription, 'path'>,
): CloudSafe<CloudAssetDescription> {
  assertCloudAllowed(localOnly, asset)
  return mint({
    path: asset.path,
    description: asset.description,
    truncated: asset.truncated,
  })
}

/**
 * Gate a text selection (the AI menu's editor selection) for an outbound
 * payload. The selection is note content, so the same contract as
 * {@link cloudSafeNoteContent} applies: callers pass the source note's **live**
 * privacy flag, and a private note throws {@link PrivateNoteError} before the
 * text is minted. `SelectionTransformService` only renders its prompt from the
 * minted value, so an unchecked selection cannot typecheck its way to a provider.
 */
export function cloudSafeSelection(
  localOnly: LocalOnlyFolders,
  note: CloudSendable,
  selectedText: string,
): CloudSafe<string> {
  assertCloudAllowed(localOnly, note)
  return mint(selectedText)
}

export interface PrivacyServiceDeps {
  readonly noteFile: NoteFileService
  readonly graphSession: GraphSessionSource
}

/**
 * The `private: true` gate every outbound payload passes through. Each method
 * checks the local-only folders of the graph open at its call; with no graph
 * open, every note counts as private.
 */
export interface PrivacyService {
  /**
   * Whether `note` may not leave the device; see {@link isPrivateNote}.
   */
  isPrivateNote(note: CloudSendable): boolean
  /**
   * Throw {@link PrivateNoteError} unless `note`'s content may leave the device.
   */
  assertCloudAllowed(note: CloudSendable): void
  /**
   * Whether a note's own frontmatter keeps it on the device; see {@link notePrivate}.
   */
  notePrivate(source: string): boolean
  /**
   * Read a note's live privacy from disk through the shareable read, which
   * refuses a local-only note however its path is spelled. Fails closed: a
   * local-only, missing or unreadable note counts as private.
   */
  isPrivateLive(path: string): Promise<boolean>
  /**
   * Gate a link destination before metadata lookup fetches it for a note.
   */
  cloudSafeLinkHref(note: CloudSendable, href: string): CloudSafe<string>
  /**
   * Gate retrieval hits for an outbound payload: private hits are dropped
   * **entirely** (even a bare title is a leak), and the rest are stripped to
   * the cloud-facing fields. The index's flags only prefilter: the index can
   * lag a just-saved `private: true`, so every surviving hit is re-checked
   * against the note on disk, failing closed. `restricted` adds a check on a
   * hit's live note source (the chat tools recheck its attachment text); a
   * hit it answers `true` for is dropped too.
   */
  cloudSafeSearchHits(
    hits: readonly RetrievalHit[],
    restricted?: (hit: RetrievalHit, source: string) => Promise<boolean>,
  ): Promise<CloudSafe<CloudSearchHit>[]>
  /**
   * Gate note-list entries (recents, daily ranges) for an outbound payload,
   * with the same contract as {@link PrivacyService.cloudSafeSearchHits}.
   */
  cloudSafeNoteListings(
    entries: readonly (CloudSendable & Omit<CloudNoteListing, 'path'>)[],
  ): Promise<CloudSafe<CloudNoteListing>[]>
  /**
   * Gate the graph-level stats block, computed over public rows only.
   */
  cloudSafeGraphContext(context: CloudGraphContext): CloudSafe<CloudGraphContext>
  /**
   * Gate one note's content, given its live privacy flag.
   */
  cloudSafeNoteContent(
    note: CloudSendable & Omit<CloudNoteContent, 'path'>,
  ): CloudSafe<CloudNoteContent>
  /**
   * Gate one asset's stored description, given the asset's live verdict.
   */
  cloudSafeAssetDescription(
    asset: CloudSendable & Omit<CloudAssetDescription, 'path'>,
  ): CloudSafe<CloudAssetDescription>
  /**
   * Gate an editor selection, given its source note's live privacy flag.
   */
  cloudSafeSelection(note: CloudSendable, selectedText: string): CloudSafe<string>
}

/**
 * The open graph as the gate reads it: its file generation and local-only folders.
 */
interface GateSession {
  readonly generation: number
  readonly localOnly: LocalOnlyFolders
}

class PrivacyServiceImpl implements PrivacyService {
  readonly #deps: PrivacyServiceDeps

  constructor(deps: PrivacyServiceDeps) {
    this.#deps = deps
  }

  isPrivateNote(note: CloudSendable): boolean {
    const session = this.#session()
    return session === null || isPrivateNote(session.localOnly, note)
  }

  assertCloudAllowed(note: CloudSendable): void {
    assertCloudAllowed(this.#localOnlyFor(note), note)
  }

  notePrivate(source: string): boolean {
    return notePrivate(source)
  }

  async isPrivateLive(path: string): Promise<boolean> {
    const session = this.#session()
    return session === null || (await this.#publicSource(path, session)) === null
  }

  cloudSafeLinkHref(note: CloudSendable, href: string): CloudSafe<string> {
    return cloudSafeLinkHref(this.#localOnlyFor(note), note, href)
  }

  async cloudSafeSearchHits(
    hits: readonly RetrievalHit[],
    restricted?: (hit: RetrievalHit, source: string) => Promise<boolean>,
  ): Promise<CloudSafe<CloudSearchHit>[]> {
    const session = this.#session()
    if (session === null) {
      return []
    }
    return await searchHitsWithProbe(session.localOnly, hits, async (hit) => {
      const source = await this.#publicSource(hit.path, session)
      if (source === null) {
        return true
      }
      try {
        return (await restricted?.(hit, source.content)) ?? false
      } catch {
        return true
      }
    })
  }

  async cloudSafeNoteListings(
    entries: readonly (CloudSendable & Omit<CloudNoteListing, 'path'>)[],
  ): Promise<CloudSafe<CloudNoteListing>[]> {
    const session = this.#session()
    if (session === null) {
      return []
    }
    return await noteListingsWithProbe(
      session.localOnly,
      entries,
      async (path) => (await this.#publicSource(path, session)) === null,
    )
  }

  cloudSafeGraphContext(context: CloudGraphContext): CloudSafe<CloudGraphContext> {
    return cloudSafeGraphContext(context)
  }

  cloudSafeNoteContent(
    note: CloudSendable & Omit<CloudNoteContent, 'path'>,
  ): CloudSafe<CloudNoteContent> {
    return cloudSafeNoteContent(this.#localOnlyFor(note), note)
  }

  cloudSafeAssetDescription(
    asset: CloudSendable & Omit<CloudAssetDescription, 'path'>,
  ): CloudSafe<CloudAssetDescription> {
    return cloudSafeAssetDescription(this.#localOnlyFor(asset), asset)
  }

  cloudSafeSelection(note: CloudSendable, selectedText: string): CloudSafe<string> {
    return cloudSafeSelection(this.#localOnlyFor(note), note, selectedText)
  }

  #session(): GateSession | null {
    return this.#deps.graphSession.getState().session
  }

  /**
   * The open graph's local-only folders; with no graph open the gate fails
   * closed, refusing `note` before a pure gate could mint it.
   */
  #localOnlyFor(note: CloudSendable): LocalOnlyFolders {
    const session = this.#session()
    if (session === null) {
      throw new PrivateNoteError(note.path)
    }
    return session.localOnly
  }

  /**
   * The note's live public source, or `null` when it may not leave the
   * device: local-only by its path or by the entry it resolves to, private by
   * its frontmatter, missing, or unreadable.
   */
  async #publicSource(path: string, session: GateSession): Promise<{ content: string } | null> {
    if (isLocalOnlyPath(session.localOnly, path)) {
      return null
    }
    try {
      const read = await this.#deps.noteFile.readShareable(path, session.generation)
      return read.kind === 'content' && !notePrivate(read.content)
        ? { content: read.content }
        : null
    } catch {
      return null
    }
  }
}

export function createPrivacyService(deps: PrivacyServiceDeps): PrivacyService {
  return new PrivacyServiceImpl(deps)
}
