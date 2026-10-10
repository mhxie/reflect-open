import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  EmbedResolver,
  FileInfo,
  FileLinkResolver,
  ImageUrlResolver,
  WikiEmbedResolver,
} from '@meowdown/core'
import {
  assetFileName,
  assetLinkDestination,
  createAsset,
  errorMessage,
  isLocalOnlyPath,
  isSafeVisibleGraphPath,
  pageLinkPath,
  resolveAttachmentLink,
} from '@reflect/core'
import { createPdfEmbedResolver } from '@/editor/pdf-embed-resolver.ts'
import { useNoteAttachments } from '@/editor/use-note-attachments.ts'
import { formatBytes } from '@/lib/format-bytes.ts'
import { openAttachment } from '@/lib/open-attachment.ts'
import { startOperation } from '@/lib/operations.ts'
import { loadAttachmentCatalog } from '@/lib/attachment-catalog.ts'

/**
 * Above this size, a save gets a non-blocking status-line warning. Never a
 * wall (it's the user's disk), and not a modal either — the drop already
 * said what the user wants — but git backup is the quiet constraint: every
 * binary lives in history forever, and GitHub hard-rejects files over
 * 100 MB, so the size is worth a mention.
 */
export const LARGE_FILE_BYTES = 25 * 1024 * 1024

/** Asset file extension for each image MIME type that gets `pasted-…` naming. */
const EXTENSION_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
}

/** A visible managed file, including formats that can only be revealed. */
function isManagedAssetPath(path: string): boolean {
  return path.startsWith('assets/') && !path.includes('\0') && isSafeVisibleGraphPath(path)
}

/** The failed save the pane reports on: which banner copy, and the cause. */
export interface AssetSaveError {
  /** 'image' for `image/*` files, 'file' for everything else. */
  kind: 'image' | 'file'
  message: string
}

export interface AssetPersistence {
  /** Resolve an image source in the note to a displayable URL, possibly later. */
  resolveImageUrl: ImageUrlResolver
  /** Render the note's PDF embeds as inline page-by-page previews. */
  resolveEmbed: EmbedResolver
  /**
   * Resolve an image source or link destination in the note to the
   * graph-relative attachment {@link openAsset} opens (null for remote,
   * note, and unsafe destinations).
   */
  resolveAssetOpenPath: (src: string) => string | null
  /** Classify the note's `![[embeds]]` (see `useNoteAttachments`). */
  resolveWikiEmbed: WikiEmbedResolver
  /** Claim the note's links to local attachments as file pills. */
  resolveFileLink: FileLinkResolver
  /**
   * Open a vetted graph-relative asset path in the OS default application.
   * A refused file type degrades to revealing the file in the OS file
   * manager; a failed open surfaces on the status line, never a rejection.
   */
  openAsset: (path: string) => Promise<void>
  /**
   * Persist a pasted/dropped file into the note's attachment folder,
   * returning the Markdown destination that links it — or null when
   * declined, failed (the failure lands on {@link AssetPersistence.saveError},
   * never a throw), or no graph is open. Rust picks the folder from the note:
   * `assets/` (linked as `assets/…`), or an editable local-only note's
   * `<folder>/assets/` (linked vault-root-absolute, `/<folder>/assets/…`).
   * Images get `pasted-…` names (screenshots have no meaningful name);
   * everything else keeps its original filename, sanitized, since the name
   * is the visible link text.
   */
  saveFile: (file: File) => Promise<string | null>
  /**
   * Resolve the size a file pill shows for a claimed attachment link or
   * embed; undefined for anything else or a file the catalog doesn't list.
   */
  resolveFileInfo: (href: string) => Promise<FileInfo | undefined>
  /** The most recent failed save; cleared by the next success. */
  saveError: AssetSaveError | null
}

/**
 * Asset handling for the note at `path` in one open graph: resolve its images,
 * embeds, and attachment links from the note's own folder
 * ({@link useNoteAttachments}; local files become `reflect-asset://` URLs
 * served off the UI thread by the Rust shell), open attachments in the OS
 * viewer, and persist pasted/dropped files by streaming them into the note's
 * attachment folder — the graph's `assets/`, or an editable local-only
 * note's own `<folder>/assets/`, never the synced one; Rust picks it from the
 * note and resolves `-2`-style name collisions at write time. A save over
 * {@link LARGE_FILE_BYTES} into the backed-up `assets/` gets a non-blocking
 * status-line warning after it lands. `generation` pins every save — and
 * every image URL — to the issuing graph session, so a save or image load
 * racing a graph switch is rejected loudly instead of landing in (or reading
 * from) the wrong graph. `path` names the note each save is for, read when
 * the save starts (a pane is reused across note switches), and scopes the
 * error banner to that note.
 */
export function useAssetPersistence(
  generation: number | null,
  path: string,
  /** Where an embedded PDF opens on double-click; the default app when absent. */
  openPdf?: (path: string) => void,
): AssetPersistence {
  const [saveError, setSaveError] = useState<AssetSaveError | null>(null)
  // Stamps the note session a save was started for. The pane outlives the
  // note (and graph session) it shows, so a save that finishes after a
  // switch must not put its outcome on the *next* note's banner.
  const sessionEpoch = useRef(0)
  // File-pill sizes of this session's saves, by graph-relative asset path:
  // the size is already in hand, while the attachment catalog only lists the
  // file once the watcher reports it.
  const savedSizes = useRef(new Map<string, number>())
  const { resolveAttachmentPath, resolveImageUrl, resolveWikiEmbed } = useNoteAttachments(
    generation,
    path,
  )

  useEffect(() => {
    return () => {
      sessionEpoch.current += 1
      setSaveError(null)
    }
  }, [path, generation])

  useEffect(() => {
    return () => {
      // Replace the map rather than clearing it: a save still in flight for
      // the old graph session writes into the orphaned instance, never into
      // the next session's cache.
      savedSizes.current = new Map()
    }
  }, [generation])

  const resolveAssetOpenPath = useCallback(
    (source: string): string | null =>
      generation === null
        ? null
        : // A page opens in the browser, so it is read as the browser reads a
          // relative link: from the note's folder.
          (pageLinkPath(path, source) ??
          resolveAttachmentPath(source) ??
          (isManagedAssetPath(source) ? source : null)),
    [generation, path, resolveAttachmentPath],
  )
  const resolveFileLink = useCallback<FileLinkResolver>(
    ({ href }) => isManagedAssetPath(href) || resolveAttachmentLink(path, href, null) !== null,
    [path],
  )

  const openAsset = useCallback(
    async (assetPath: string): Promise<void> => {
      if (generation === null) {
        return
      }
      await openAttachment(assetPath, generation)
    },
    [generation],
  )
  const resolveEmbed = useMemo(
    () =>
      createPdfEmbedResolver({
        generation,
        notePath: path,
        openAsset: (assetPath) =>
          openPdf === undefined ? void openAsset(assetPath) : openPdf(assetPath),
      }),
    [generation, path, openAsset, openPdf],
  )

  const saveFile = useCallback(
    async (file: File): Promise<string | null> => {
      if (generation === null) {
        return null
      }
      const epoch = sessionEpoch.current
      const isStale = (): boolean => sessionEpoch.current !== epoch
      const imageExtension = EXTENSION_BY_MIME[file.type]
      // Rust owns collision suffixes, so two pastes in the same millisecond
      // land as `pasted-<ts>.png` and `pasted-<ts>-2.png`.
      const desiredName = imageExtension
        ? `pasted-${Date.now()}.${imageExtension}`
        : assetFileName(file.name)
      // Captured before the await: a save resolving after a graph switch
      // seeds the orphaned session's cache, not the next graph's.
      const sizeCache = savedSizes.current
      try {
        // The note this save is for decides where the file lands, so it is
        // the path this callback holds now, never one cached at mount.
        const saved = await createAsset(desiredName, file, path, generation)
        sizeCache.set(saved, file.size)
        // A local-only folder's attachment never enters the Git backup.
        if (file.size > LARGE_FILE_BYTES && !isLocalOnlyPath(saved)) {
          startOperation('Large file added').warn(
            `“${file.name}” is ${formatBytes(file.size)}. Git keeps every version forever; GitHub rejects files over 100 MB.`,
          )
        }
        if (!isStale()) {
          setSaveError(null)
        }
        return assetLinkDestination(saved)
      } catch (cause) {
        // Owned here (not thrown to meowdown's error callback) so a save
        // finishing late can be dropped instead of blaming the next note.
        // The kind mirrors the naming decision above: an image MIME without
        // a known extension was saved as a named attachment, so its failure
        // reads as a file, not a "pasted image".
        if (!isStale()) {
          setSaveError({
            kind: imageExtension ? 'image' : 'file',
            message: errorMessage(cause),
          })
        }
        return null
      }
    },
    [generation, path],
  )

  const resolveFileInfo = useCallback(
    async (href: string): Promise<FileInfo | undefined> => {
      if (generation === null) {
        return undefined
      }
      const saved = savedSizes.current
      // This session's saves are keyed by graph-relative path; the link's
      // vault reading names it (`assets/…` as written, `/<folder>/assets/…`
      // without its slash).
      const linked = resolveAttachmentLink(path, href, null)
      const savedSize = linked === null ? undefined : saved.get(linked)
      if (savedSize !== undefined) {
        return { size: savedSize }
      }
      try {
        // Waits for the first listing, so a pill rendered before the catalog
        // arrived still resolves the file (and size) it will display.
        const catalog = await loadAttachmentCatalog(generation)
        const assetPath = resolveAttachmentLink(path, href, catalog)
        const size =
          assetPath === null ? undefined : (saved.get(assetPath) ?? catalog.size(assetPath))
        return size === undefined ? undefined : { size }
      } catch {
        // A failed listing degrades to a pill without a size, per the
        // documented contract (undefined, never a rejection).
        return undefined
      }
    },
    [generation, path],
  )

  return useMemo<AssetPersistence>(
    () => ({
      resolveImageUrl,
      resolveEmbed,
      resolveAssetOpenPath,
      resolveWikiEmbed,
      resolveFileLink,
      openAsset,
      saveFile,
      resolveFileInfo,
      saveError,
    }),
    [
      resolveImageUrl,
      resolveEmbed,
      resolveAssetOpenPath,
      resolveWikiEmbed,
      resolveFileLink,
      openAsset,
      saveFile,
      resolveFileInfo,
      saveError,
    ],
  )
}
