import { isAppError } from '../errors.ts'
import type { GraphSessionSource } from '../graph/graph-session.ts'
import { isLocalOnlyPath, type LocalOnlyFolders } from '../graph/local-only.ts'
import type { NoteFileService } from '../graph/note-file-service.ts'
import { assetReferenceMatches, type AssetReferences } from '../indexing/asset-refs.ts'
import { parseNote } from '../markdown/extract.ts'
import type { XArchiveService } from '../embeds/x-archive-service.ts'

/**
 * Outcome of the privacy gate for one asset.
 */
export type AssetVerdict = 'send' | 'skip-unreferenced' | 'skip-private'

/**
 * The asset privacy verdict both asset-description consumers share: the
 * generation pass (`AssetDescriptionService`) decides whether an asset's
 * bytes may be sent to a provider, and the chat read_assets tool decides
 * whether its stored description may be — the sidecar on disk can predate a
 * note turning private, so the read path re-runs the same verdict live.
 *
 * The contract: sendable only when the asset is referenced by ≥1 non-private
 * note and by **0** private notes. Candidates come from the index, but the
 * verdict is made from each candidate's live markdown, failing closed. A note
 * inside a local-only folder counts as private without being read, and an
 * asset that itself lives in one is never sendable. The folders are the open
 * graph's (`GraphSession.localOnly`); without an open graph nothing is sendable.
 */
export interface AssetPrivacyService {
  /**
   * Decide whether an asset may be sent: referenced by ≥1 non-private note and by
   * **0** private notes (unreferenced → skip). Candidate notes come from the
   * index, but the verdict is made from each candidate's **live** markdown — the
   * private flag and a re-confirmation that the body still references the asset.
   * Fails closed: an unreadable candidate blocks the asset. The local-only
   * folders are read from the open graph at entry; a pass whose `generation` is
   * no longer the open graph's gets `'skip-private'` (its reads are pinned to
   * `generation` in Rust, so nothing it decides could land elsewhere).
   */
  classifyAsset(assetPath: string, generation: number): Promise<AssetVerdict>
  /**
   * The verdict core of {@link AssetPrivacyService.classifyAsset}, over an
   * explicit candidate list and note reader. The chat tools reuse it with
   * unpinned reads and an injectable candidate query; the description pass
   * wraps it with generation-pinned reads. The local-only folders are the open
   * graph's; with no graph open the asset is `'skip-private'`.
   */
  classifyAssetFromNotes(
    assetPath: string,
    candidates: readonly string[],
    readSource: (notePath: string) => Promise<string>,
    knownOwners?: readonly string[],
  ): Promise<AssetVerdict>
}

export interface AssetPrivacyServiceDeps {
  readonly noteFile: NoteFileService
  readonly xArchive: XArchiveService
  readonly assetReferences: AssetReferences
  readonly graphSession: GraphSessionSource
}

class AssetPrivacyServiceImpl implements AssetPrivacyService {
  readonly #deps: AssetPrivacyServiceDeps

  constructor(deps: AssetPrivacyServiceDeps) {
    this.#deps = deps
  }

  async classifyAsset(assetPath: string, generation: number): Promise<AssetVerdict> {
    const { noteFile, xArchive, assetReferences, graphSession } = this.#deps
    const { session } = graphSession.getState()
    if (session === null || session.generation !== generation) {
      return 'skip-private'
    }
    const { localOnly } = session
    const owners = await xArchive.owners(assetPath, generation)
    const candidates = await assetReferences.notePaths(assetPath, owners)
    return await this.#classify(
      localOnly,
      assetPath,
      candidates,
      (notePath) => noteFile.read(notePath, generation),
      owners,
    )
  }

  async classifyAssetFromNotes(
    assetPath: string,
    candidates: readonly string[],
    readSource: (notePath: string) => Promise<string>,
    knownOwners?: readonly string[],
  ): Promise<AssetVerdict> {
    const { session } = this.#deps.graphSession.getState()
    if (session === null) {
      return 'skip-private'
    }
    return await this.#classify(session.localOnly, assetPath, candidates, readSource, knownOwners)
  }

  async #classify(
    localOnly: LocalOnlyFolders,
    assetPath: string,
    candidates: readonly string[],
    readSource: (notePath: string) => Promise<string>,
    knownOwners?: readonly string[],
  ): Promise<AssetVerdict> {
    if (isLocalOnlyPath(localOnly, assetPath)) {
      return 'skip-private'
    }
    if (candidates.length === 0) {
      return 'skip-unreferenced'
    }
    if (candidates.some((notePath) => isLocalOnlyPath(localOnly, notePath))) {
      return 'skip-private'
    }
    const owners = knownOwners ?? (await this.#deps.xArchive.owners(assetPath))
    const references = [assetPath, ...owners]
    let publicRefs = 0
    for (const notePath of candidates) {
      let source: string
      try {
        source = await readSource(notePath)
      } catch (cause) {
        if (isAppError(cause) && cause.kind === 'notFound') {
          continue
        }
        return 'skip-private'
      }
      const parsed = parseNote({ path: notePath, source })
      if (
        !parsed.assets.some((ref) =>
          references.some((path) => assetReferenceMatches(ref.path, path)),
        )
      ) {
        continue
      }
      if (parsed.frontmatter.private) {
        return 'skip-private'
      }
      publicRefs += 1
    }
    return publicRefs > 0 ? 'send' : 'skip-unreferenced'
  }
}

export function createAssetPrivacyService(deps: AssetPrivacyServiceDeps): AssetPrivacyService {
  return new AssetPrivacyServiceImpl(deps)
}
