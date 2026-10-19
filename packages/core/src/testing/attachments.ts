import {
  createGraphSession,
  requireGraphSession,
  type GraphSessionSource,
} from '../graph/graph-session.ts'
import { appleFileSrc } from '../ports/file-src.ts'
import {
  createAttachmentSaveScope,
  isManagedAssetPath,
  wikiEmbedDisplay,
  type AssetSaveError,
  type AssetSaveResult,
  type AttachFilesRequest,
  type AttachmentSaveScope,
  type AttachmentService,
  type WikiEmbedDisplay,
} from '../documents/attachment-service.ts'
import type { Unlisten } from '../unlisten.ts'
import { AppError } from '../errors.ts'
import type { FileMeta, PdfInfo } from '../graph/schemas.ts'
import { assetFileName, assetLinkDestination } from '../graph/asset-names.ts'
import {
  createAttachmentCatalog,
  isPdfAttachmentPath,
  pageLinkPath,
  resolveAttachmentLink,
  type AttachmentCatalog,
} from '../graph/attachment-resolution.ts'
import { isLocalOnlyPath, NO_LOCAL_ONLY_FOLDERS } from '../graph/local-only.ts'
import { pdfPageWidthBucket } from '../graph/pdf-pages.ts'

export interface TestAttachmentEntry {
  path: string
  size: number
  /**
   * What `listFiles` reports as the file's modification time; defaults to 0.
   */
  modifiedMs?: number
}

export interface TestAttachmentServiceOptions {
  /**
   * The attachment listing every generation's catalog is built from.
   */
  catalog?: readonly TestAttachmentEntry[]
  /**
   * The page sizes `pdfInfo` answers, by graph-relative path; any other path
   * rejects as an unreadable PDF.
   */
  pdfs?: Readonly<Record<string, PdfInfo>>
  /**
   * Make `openOrReveal` fall back to a reveal, as for a refused file type.
   */
  refuseOpen?: boolean
  /**
   * Where the open graph is read from. Defaults to a graph of generation 1 that is always open.
   */
  graphSession?: GraphSessionSource
}

export interface AttachmentSave {
  name: string
  type: string
  size: number
  generation: number
  path: string
  /**
   * The note the file was saved for.
   */
  notePath: string
}

export interface TestAttachmentService extends AttachmentService {
  /**
   * Replace the listing without notifying `onCatalogChanged` listeners.
   */
  setCatalog(entries: readonly TestAttachmentEntry[]): void
  /**
   * Notify every `onCatalogChanged` listener.
   */
  emitCatalogChanged(): void
  /**
   * Make later saves fail with `error`; `null` makes them succeed again.
   */
  failSaves(error: AssetSaveError | null): void
  /**
   * Every successful save, in order.
   */
  saves(): readonly AttachmentSave[]
  /**
   * Every path opened, in order.
   */
  opened(): readonly string[]
  /**
   * Every path revealed, in order.
   */
  revealed(): readonly string[]
  /**
   * Every `attachFilesToNote` request, in order.
   */
  attachRequests(): readonly AttachFilesRequest[]
  /**
   * How many `watchCatalog` subscriptions are active.
   */
  watchers(): number
}

class TestAttachmentServiceImpl implements TestAttachmentService {
  readonly #options: TestAttachmentServiceOptions | undefined
  readonly #listeners = new Set<() => void>()
  readonly #saveLog: AttachmentSave[] = []
  readonly #openLog: string[] = []
  readonly #revealLog: string[] = []
  readonly #attachLog: AttachFilesRequest[] = []
  readonly #graphSession: GraphSessionSource
  #files: readonly TestAttachmentEntry[]
  #catalog: AttachmentCatalog
  #saveFailure: AssetSaveError | null = null
  #watching = 0

  constructor(options?: TestAttachmentServiceOptions) {
    this.#options = options
    this.#files = options?.catalog ?? []
    this.#catalog = createAttachmentCatalog(this.#files)
    const defaultSession = createGraphSession({
      root: '/graphs/test',
      name: 'test',
      generation: 1,
      indexGeneration: 1,
    })
    this.#graphSession = options?.graphSession ?? {
      getState: () => ({ session: defaultSession }),
    }
  }

  peekCatalog(): AttachmentCatalog | null {
    return this.#openGeneration() === null ? null : this.#catalog
  }

  loadCatalog(): Promise<AttachmentCatalog> {
    return Promise.try(() => {
      requireGraphSession(this.#graphSession)
      return this.#catalog
    })
  }

  watchCatalog(): Unlisten {
    this.#watching += 1
    return () => {
      this.#watching -= 1
    }
  }

  onCatalogChanged(listener: () => void): Unlisten {
    const deliver = (): void => {
      listener()
    }
    this.#listeners.add(deliver)
    return () => {
      this.#listeners.delete(deliver)
    }
  }

  listFiles(): Promise<FileMeta[]> {
    return Promise.resolve(
      this.#files.map(({ path, size, modifiedMs }) => ({
        path,
        size,
        modifiedMs: modifiedMs ?? 0,
      })),
    )
  }

  pdfInfo(path: string): Promise<PdfInfo> {
    return Promise.try(() => {
      const info = this.#options?.pdfs?.[path]
      if (info === undefined) {
        throw new AppError('invalid', `${path} is not a readable PDF`)
      }
      return info
    })
  }

  resolveAttachmentPath(notePath: string, destination: string): string | null {
    return this.#resolveAttachmentPath(notePath, destination, this.#openGeneration())
  }

  resolveAssetOpenPath(notePath: string, source: string): string | null {
    const generation = this.#openGeneration()
    if (generation === null) {
      return null
    }
    return (
      pageLinkPath(notePath, source) ??
      this.#resolveAttachmentPath(notePath, source, generation) ??
      (isManagedAssetPath(source) ? source : null)
    )
  }

  resolveImageUrl(notePath: string, source: string): string | undefined {
    return this.#resolveImageUrl(notePath, source, this.#openGeneration())
  }

  assetUrl(path: string, generation: number): string {
    return appleFileSrc(`${generation}/${path}`, 'reflect-asset')
  }

  pdfPageUrl(path: string, page: number, width: number, generation: number): string {
    return `${this.assetUrl(path, generation)}?reflect-preview=pdf-page&page=${page}&width=${width}`
  }

  imageThumbnailUrl(path: string, width: number, generation: number): string {
    return `${this.assetUrl(path, generation)}?reflect-preview=thumb&width=${width}`
  }

  resolvePreviewImageUrl(
    notePath: string,
    source: string,
    generation: number,
  ): Promise<string | undefined> {
    return Promise.try(() => {
      const path = this.#resolveAttachmentPath(notePath, source, generation)
      if (path === null || path.toLowerCase().endsWith('.svg')) {
        return
      }
      const url = this.#resolveImageUrl(notePath, source, generation)
      return url === undefined ? undefined : `${url}?reflect-preview=raster`
    })
  }

  resolveWikiEmbed(target: string): WikiEmbedDisplay | undefined {
    return wikiEmbedDisplay(target)
  }

  claimsFileLink(notePath: string, href: string): boolean {
    return isManagedAssetPath(href) || resolveAttachmentLink(notePath, href, null) !== null
  }

  resolveFileInfo(notePath: string, href: string): Promise<{ size: number } | undefined> {
    return Promise.try(() => {
      const path = this.#resolveAttachmentPath(notePath, href, this.#openGeneration())
      const size = path === null ? undefined : this.#catalog.size(path)
      return size === undefined ? undefined : { size }
    })
  }

  saveFile(file: File, notePath: string): Promise<AssetSaveResult | null> {
    return Promise.try(() => {
      const generation = this.#openGeneration()
      if (generation === null) {
        return null
      }
      if (this.#saveFailure !== null) {
        return { ok: false, error: this.#saveFailure }
      }
      const path = `assets/${assetFileName(file.name)}`
      this.#saveLog.push({
        name: file.name,
        type: file.type,
        size: file.size,
        generation,
        path,
        notePath,
      })
      return { ok: true, path, destination: assetLinkDestination(path) }
    })
  }

  createSaveScope(): AttachmentSaveScope {
    return createAttachmentSaveScope({
      save: (file, notePath) => this.saveFile(file, notePath),
    })
  }

  attachFilesToNote(request: AttachFilesRequest): Promise<void> {
    if (this.#openGeneration() !== null) {
      this.#attachLog.push(request)
    }
    return Promise.resolve()
  }

  openOrReveal(path: string): Promise<void> {
    if (this.#openGeneration() === null) {
      return Promise.resolve()
    }
    if (this.#options?.refuseOpen === true) {
      this.#revealLog.push(path)
    } else {
      this.#openLog.push(path)
    }
    return Promise.resolve()
  }

  reveal(path: string, generation: number): Promise<void> {
    return Promise.try(() => {
      // Rust refuses a reveal for any session but the open one.
      if (generation !== this.#openGeneration()) {
        throw new AppError('io', 'the graph changed since this command was issued; dropping it')
      }
      this.#revealLog.push(path)
    })
  }

  setCatalog(entries: readonly TestAttachmentEntry[]): void {
    this.#files = entries
    this.#catalog = createAttachmentCatalog(entries)
  }

  emitCatalogChanged(): void {
    for (const listener of this.#listeners) {
      listener()
    }
  }

  failSaves(error: AssetSaveError | null): void {
    this.#saveFailure = error
  }

  saves(): readonly AttachmentSave[] {
    return [...this.#saveLog]
  }

  opened(): readonly string[] {
    return [...this.#openLog]
  }

  revealed(): readonly string[] {
    return [...this.#revealLog]
  }

  attachRequests(): readonly AttachFilesRequest[] {
    return [...this.#attachLog]
  }

  watchers(): number {
    return this.#watching
  }

  #openGeneration(): number | null {
    return this.#graphSession.getState().session?.generation ?? null
  }

  #resolveAttachmentPath(
    notePath: string,
    destination: string,
    generation: number | null,
  ): string | null {
    return generation === null ? null : resolveAttachmentLink(notePath, destination, this.#catalog)
  }

  #resolveImageUrl(
    notePath: string,
    source: string,
    generation: number | null,
  ): string | undefined {
    if (/^https?:\/\//i.test(source)) {
      const localOnly = this.#graphSession.getState().session?.localOnly ?? NO_LOCAL_ONLY_FOLDERS
      return isLocalOnlyPath(localOnly, notePath) ? undefined : source
    }
    const path = this.#resolveAttachmentPath(notePath, source, generation)
    if (path === null || generation === null) {
      return undefined
    }
    return isPdfAttachmentPath(path)
      ? this.pdfPageUrl(path, 1, pdfPageWidthBucket(0), generation)
      : this.assetUrl(path, generation)
  }
}

/**
 * An in-memory {@link AttachmentService} whose catalog is always loaded.
 * Saves land at `assets/<sanitized name>`; image URLs use the Apple
 * `reflect-asset://localhost/` shape.
 */
export function createTestAttachmentService(
  options?: TestAttachmentServiceOptions,
): TestAttachmentService {
  return new TestAttachmentServiceImpl(options)
}
