import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import type {
  EmbedResolver,
  FileInfo,
  FileLinkResolver,
  ImageUrlResolver,
  WikiEmbedResolver,
} from '@meowdown/core'
import type { AssetSaveError } from '@reflect/core'
import { createPdfEmbedResolver } from '@/editor/pdf-embed-resolver.ts'
import { useNoteAttachments } from '@/editor/use-note-attachments.ts'
import { useMaybeGraph } from '@/providers/graph-provider.tsx'
import { useCoreServices } from '@/services/services-provider.tsx'

export type { AssetSaveError }

export interface AssetPersistence {
  /**
   * Resolve an image source in the note to a displayable URL, possibly later.
   */
  resolveImageUrl: ImageUrlResolver
  /**
   * Render the note's PDF embeds as inline page-by-page previews.
   */
  resolveEmbed: EmbedResolver
  /**
   * Resolve an image source or link destination in the note to the
   * graph-relative attachment {@link openAsset} opens (null for remote,
   * note, and unsafe destinations).
   */
  resolveAssetOpenPath: (src: string) => string | null
  /**
   * Classify the note's `![[embeds]]` (see `useNoteAttachments`).
   */
  resolveWikiEmbed: WikiEmbedResolver
  /**
   * Claim the note's links to local attachments as file pills.
   */
  resolveFileLink: FileLinkResolver
  /**
   * Open a vetted graph-relative asset path in the OS default application.
   * A refused file type degrades to revealing the file in the OS file
   * manager; a failed open surfaces on the status line, never a rejection.
   */
  openAsset: (path: string) => Promise<void>
  /**
   * Persist a pasted/dropped file into the note's attachment folder,
   * returning the Markdown destination that links it, or null when failed
   * (the failure lands on {@link AssetPersistence.saveError}, never a throw)
   * or no graph is open. Rust picks the folder from the note: `assets/`
   * (linked as `assets/…`), or an editable local-only note's
   * `<folder>/assets/` (linked vault-root-absolute, `/<folder>/assets/…`).
   */
  saveFile: (file: File) => Promise<string | null>
  /**
   * Resolve the size a file pill shows for a claimed attachment link or
   * embed; undefined for anything else or a file the catalog doesn't list.
   */
  resolveFileInfo: (href: string) => Promise<FileInfo | undefined>
  /**
   * The most recent failed save; cleared by the next success.
   */
  saveError: AssetSaveError | null
}

/**
 * Asset handling for the note at `path` in the open graph, through the
 * `AttachmentService`. Each save is for the note the pane shows when the save
 * starts (a pane is reused across note switches), so it lands in that note's
 * attachment folder; the error banner is scoped to that note and the graph it
 * is in.
 *
 * @param openPdf where an embedded PDF opens on double-click; the default app
 *   when absent.
 */
export function useAssetPersistence(
  path: string,
  openPdf?: (path: string) => void,
): AssetPersistence {
  const graph = useMaybeGraph()?.graph ?? null
  const generation = graph?.generation ?? null
  const { attachments, platform } = useCoreServices()
  const noteAttachments = useNoteAttachments(path)
  const { resolveImageUrl, resolveWikiEmbed } = noteAttachments
  // The pane outlives the note (and graph session) it shows, so a save that
  // finishes after a switch must not put its outcome on the next note's banner.
  const saveScope = useMemo(() => attachments.createSaveScope(), [attachments])
  const subscribeSaveError = useCallback(
    (listener: () => void) => saveScope.subscribe(listener),
    [saveScope],
  )
  const getSaveError = useCallback(() => saveScope.error(), [saveScope])
  const saveError = useSyncExternalStore(subscribeSaveError, getSaveError)

  useEffect(() => {
    return () => {
      saveScope.reset()
    }
  }, [saveScope, path, graph])

  const resolveAssetOpenPath = useCallback(
    (source: string): string | null => attachments.resolveAssetOpenPath(path, source),
    [attachments, path],
  )
  const resolveFileLink = useCallback<FileLinkResolver>(
    ({ href }) => attachments.claimsFileLink(path, href),
    [attachments, path],
  )

  const openAsset = useCallback(
    async (assetPath: string): Promise<void> => {
      await attachments.openOrReveal(assetPath)
    },
    [attachments],
  )

  const resolveEmbed = useMemo(() => {
    return createPdfEmbedResolver({
      generation,
      notePath: path,
      attachments,
      noteAttachments,
      mobileApp: platform.surface.mobileApp,
      openAsset: (assetPath) => {
        if (openPdf === undefined) {
          void openAsset(assetPath)
        } else {
          openPdf(assetPath)
        }
      },
    })
  }, [generation, path, attachments, noteAttachments, platform, openAsset, openPdf])

  const saveFile = useCallback(
    // The note this save is for decides where the file lands, so it is the
    // path this callback holds now, never one cached at mount.
    async (file: File): Promise<string | null> => await saveScope.saveFile(file, path),
    [saveScope, path],
  )

  const resolveFileInfo = useCallback(
    async (href: string): Promise<FileInfo | undefined> => {
      return await attachments.resolveFileInfo(path, href)
    },
    [attachments, path],
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
