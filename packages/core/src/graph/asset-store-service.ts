import type { MaybePromise } from '@reflect/utils'
import { z } from 'zod'
import type { ClockService } from '../ports/clock-service.ts'
import type { FileChangeService } from '../indexing/file-change-service.ts'
import type { IpcBridgeService } from '../ipc/ipc-service.ts'
import { base64ToBytes, blobChunks, bytesToBase64 } from '@reflect/utils'
import { pdfInfoSchema, type PdfInfo } from './schemas.ts'

/**

 * Commands that return `()` from Rust serialize as `null` over IPC.

 */
const voidSchema = z.null()

/**
 * Upload chunk size. Big enough that a large file doesn't drown in IPC
 * round-trips, small enough that webview memory holds one chunk, never the
 * whole file.
 */
const CHUNK_BYTES = 4 * 1024 * 1024

/**

 * The header carrying the upload id on raw-body append calls.

 */
const UPLOAD_ID_HEADER = 'x-upload-id'

const localOcrSupportSchema = z.object({
  /**
   * Safe device-only OCR cache writes (macOS and Linux).
   */
  cache: z.boolean(),
  /**
   * PDF page rendering for OCR (macOS only).
   */
  pdf: z.boolean(),
})

/**
 * What local OCR this native platform supports.
 */
export type LocalOcrSupport = z.infer<typeof localOcrSupportSchema>

/**
 * Binary files in the graph: attachments under `assets/` (or an editable
 * local-only folder's own `assets/`), audio memos under `audio-memos/`, and
 * the transcript and OCR caches under `.reflect/`. Every call is pinned to a
 * graph `generation`. Writes are reported to
 * {@link FileChangeService.reportOwnWrite} after they land.
 */
export interface AssetStoreService {
  /**
   * Stream a blob into the attachment folder of the note at `notePath` as
   * `desiredName`, or the first free `-2`-suffixed variant, and resolve with
   * the final graph-relative path. Rust decides the folder from the note:
   * `assets/…` for an ordinary note, `<folder>/assets/…` for a note in an
   * editable local-only folder (whose attachments never enter the synced
   * `assets/`); a note in a read-only local-only folder takes none. Bytes
   * travel in 4 MiB raw binary chunks; a failure aborts the upload and
   * rethrows. Requires a binary transport.
   */
  uploadBlob(
    desiredName: string,
    contents: Blob,
    notePath: string,
    generation: number,
  ): Promise<string>
  /**
   * Write a blob to an exact graph-relative path. Streams like
   * {@link uploadBlob} when the transport carries binary bodies, otherwise
   * sends the bytes base64-encoded.
   */
  uploadToPath(path: string, contents: Blob, generation: number): Promise<void>
  /**
   * Copy a file the OS gave a real path for into the attachment folder of the
   * note at `notePath` as `desiredName`, with the destination rule and
   * collision policy of {@link uploadBlob}. The bytes never enter webview
   * memory.
   */
  importFile(
    sourcePath: string,
    desiredName: string,
    notePath: string,
    generation: number,
  ): MaybePromise<string>
  /**
   * Write base64-encoded bytes to a graph-relative path.
   */
  writeBase64(path: string, contentsBase64: string, generation: number): MaybePromise<void>
  /**
   * A file's bytes, base64-encoded.
   */
  readBase64(path: string, generation: number): MaybePromise<string>
  /**
   * A file's bytes. Read as a raw binary response when the transport carries
   * binary bodies, otherwise through {@link readBase64}.
   */
  readBytes(path: string, generation: number): MaybePromise<Uint8Array<ArrayBuffer>>
  /**
   * Attachment bytes for verified on-device OCR, including local-only sources.
   */
  readBytesForDevice(path: string, generation: number): Promise<Uint8Array<ArrayBuffer>>
  /**
   * Render a 1-based PDF page to PNG for local vision models (macOS), from
   * the source snapshot whose hash is `sourceHash`.
   */
  readPdfPageForDevice(
    path: string,
    page: number,
    generation: number,
    sourceHash: string,
  ): Promise<Uint8Array<ArrayBuffer>>
  /**
   * PDF page metadata from the same verified source snapshot as local OCR.
   */
  pdfInfoForDevice(path: string, generation: number, sourceHash: string): Promise<PdfInfo>
  /**
   * The page sizes of the PDF at a graph-relative path, for an inline preview
   * (Plan 25). Rejects with `unsupported` off macOS, `locked` for a
   * password-protected PDF, and `invalid` for a file that is not a readable PDF.
   */
  pdfInfo(path: string, generation: number): Promise<PdfInfo>
  /**
   * What local OCR this native platform supports: cache writes, and PDF rendering.
   */
  localOcrSupport(generation: number): Promise<LocalOcrSupport>
  /**
   * A derived OCR cache entry from `.reflect/asset-ocr/`; a missing entry rejects with `notFound`.
   */
  readOcrCache(key: string, generation: number): Promise<string>
  /**
   * The OCR cache's digest keys.
   */
  listOcrCacheKeys(generation: number): Promise<string[]>
  /**
   * Atomically write a complete OCR cache entry into `.reflect/asset-ocr/`.
   */
  writeOcrCache(key: string, contents: string, generation: number): Promise<void>
  /**
   * Open a file in the system default application.
   */
  open(path: string, generation: number): MaybePromise<void>
  /**
   * Reveal a file in the OS file manager.
   */
  reveal(path: string, generation: number): MaybePromise<void>
  /**
   * Delete one recording. Idempotent; Rust only deletes under `audio-memos/`.
   */
  deleteAudioMemo(path: string, generation: number): MaybePromise<void>
  /**
   * Copy a recording from an OS path into `audio-memos/` at an exact path.
   * Idempotent: a segment that already landed is not copied again.
   */
  importAudioMemo(sourcePath: string, path: string, generation: number): MaybePromise<void>
  /**
   * One cached segment transcript. Rejects with `notFound` while nothing is cached.
   */
  readTranscriptCache(name: string, generation: number): MaybePromise<string>
  writeTranscriptCache(name: string, contents: string, generation: number): MaybePromise<void>
}

export interface AssetStoreServiceDeps {
  readonly ipc: IpcBridgeService
  readonly clock: ClockService
  readonly fileChanges: FileChangeService
}

class AssetStoreServiceImpl implements AssetStoreService {
  readonly #deps: AssetStoreServiceDeps

  constructor(deps: AssetStoreServiceDeps) {
    this.#deps = deps
  }

  async uploadBlob(
    desiredName: string,
    contents: Blob,
    notePath: string,
    generation: number,
  ): Promise<string> {
    const { ipc } = this.#deps
    const path = await this.#streamUpload(contents, generation, async (id) => {
      return await ipc.call(
        'asset_upload_commit',
        { id, desiredName, notePath, generation },
        z.string(),
      )
    })
    this.#reportWrite(path)
    return path
  }

  async uploadToPath(path: string, contents: Blob, generation: number): Promise<void> {
    const { ipc } = this.#deps
    if (!ipc.hasBinaryTransport) {
      const bytes = new Uint8Array(await contents.arrayBuffer())
      await this.writeBase64(path, bytesToBase64(bytes), generation)
      return
    }
    await this.#streamUpload(contents, generation, async (id) => {
      return await ipc.call('asset_upload_commit_path', { id, path, generation }, voidSchema)
    })
    this.#reportWrite(path)
  }

  async importFile(
    sourcePath: string,
    desiredName: string,
    notePath: string,
    generation: number,
  ): Promise<string> {
    const path = await this.#deps.ipc.call(
      'asset_import',
      { sourcePath, desiredName, notePath, generation },
      z.string(),
    )
    this.#reportWrite(path)
    return path
  }

  async writeBase64(path: string, contentsBase64: string, generation: number): Promise<void> {
    await this.#deps.ipc.call('asset_write', { path, contentsBase64, generation }, voidSchema)
    this.#reportWrite(path)
  }

  async readBase64(path: string, generation: number): Promise<string> {
    return await this.#deps.ipc.call('asset_read', { path, generation }, z.string())
  }

  async readBytes(path: string, generation: number): Promise<Uint8Array<ArrayBuffer>> {
    const { ipc } = this.#deps
    if (!ipc.hasBinaryTransport) {
      return base64ToBytes(await this.readBase64(path, generation))
    }
    const buffer = await ipc.call(
      'asset_read_binary',
      { path, generation },
      z.instanceof(ArrayBuffer),
    )
    return new Uint8Array(buffer)
  }

  async readBytesForDevice(path: string, generation: number): Promise<Uint8Array<ArrayBuffer>> {
    const buffer = await this.#deps.ipc.call(
      'asset_read_for_device',
      { path, generation },
      z.instanceof(ArrayBuffer),
    )
    return new Uint8Array(buffer)
  }

  async readPdfPageForDevice(
    path: string,
    page: number,
    generation: number,
    sourceHash: string,
  ): Promise<Uint8Array<ArrayBuffer>> {
    const buffer = await this.#deps.ipc.call(
      'pdf_page_read_for_device',
      { path, page, generation, sourceHash },
      z.instanceof(ArrayBuffer),
    )
    return new Uint8Array(buffer)
  }

  async pdfInfoForDevice(path: string, generation: number, sourceHash: string): Promise<PdfInfo> {
    return await this.#deps.ipc.call(
      'pdf_info_for_device',
      { path, generation, sourceHash },
      pdfInfoSchema,
    )
  }

  async pdfInfo(path: string, generation: number): Promise<PdfInfo> {
    return await this.#deps.ipc.call('pdf_info', { path, generation }, pdfInfoSchema)
  }

  async localOcrSupport(generation: number): Promise<LocalOcrSupport> {
    return await this.#deps.ipc.call('asset_ocr_supported', { generation }, localOcrSupportSchema)
  }

  async readOcrCache(key: string, generation: number): Promise<string> {
    return await this.#deps.ipc.call('asset_ocr_cache_read', { key, generation }, z.string())
  }

  async listOcrCacheKeys(generation: number): Promise<string[]> {
    return await this.#deps.ipc.call(
      'asset_ocr_cache_keys',
      { generation },
      z.array(z.string().regex(/^[a-f\d]{64}$/u)),
    )
  }

  async writeOcrCache(key: string, contents: string, generation: number): Promise<void> {
    await this.#deps.ipc.call('asset_ocr_cache_write', { key, contents, generation }, voidSchema)
  }

  async open(path: string, generation: number): Promise<void> {
    await this.#deps.ipc.call('asset_open', { path, generation }, voidSchema)
  }

  async reveal(path: string, generation: number): Promise<void> {
    await this.#deps.ipc.call('asset_reveal', { path, generation }, voidSchema)
  }

  async deleteAudioMemo(path: string, generation: number): Promise<void> {
    await this.#deps.ipc.call('audio_memo_delete', { path, generation }, voidSchema)
  }

  async importAudioMemo(sourcePath: string, path: string, generation: number): Promise<void> {
    await this.#deps.ipc.call('audio_memo_import', { sourcePath, path, generation }, voidSchema)
    this.#reportWrite(path)
  }

  async readTranscriptCache(name: string, generation: number): Promise<string> {
    return await this.#deps.ipc.call('transcript_cache_read', { name, generation }, z.string())
  }

  async writeTranscriptCache(name: string, contents: string, generation: number): Promise<void> {
    await this.#deps.ipc.call('transcript_cache_write', { name, contents, generation }, voidSchema)
  }

  #reportWrite(path: string): void {
    const { clock, fileChanges } = this.#deps
    fileChanges.reportOwnWrite([{ path, kind: 'upsert', modifiedMs: clock.now() }])
  }

  /**
   * Stage `contents` in chunks, then run `commit` with the upload id.
   */
  async #streamUpload<Result>(
    contents: Blob,
    generation: number,
    commit: (id: string) => Promise<Result>,
  ): Promise<Result> {
    const { ipc } = this.#deps
    const id = await ipc.call('asset_upload_begin', { generation }, z.string())
    try {
      for (const chunk of blobChunks(contents, CHUNK_BYTES)) {
        await ipc.callBinary(
          'asset_upload_append',
          new Uint8Array(await chunk.arrayBuffer()),
          { [UPLOAD_ID_HEADER]: id },
          voidSchema,
        )
      }
      return await commit(id)
    } catch (error) {
      // Best-effort cleanup of the staged temp file; the original error is the
      // one worth surfacing.
      await ipc.call('asset_upload_abort', { id }, voidSchema).catch(() => {})
      throw error
    }
  }
}

export function createAssetStoreService(deps: AssetStoreServiceDeps): AssetStoreService {
  return new AssetStoreServiceImpl(deps)
}
