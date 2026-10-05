import { useState, type ReactElement, type ReactNode } from 'react'
import { imageThumbnailWidthBucket, pdfPageWidthBucket } from '@reflect/core'
import { attachmentUrl, imageThumbnailUrl, pdfPageUrl } from '@/editor/use-note-attachments.ts'
import { cn } from '@/lib/utils.ts'

interface AttachmentPreviewImageProps {
  generation: number
  /** Graph-relative path of the image or PDF. */
  path: string
  /** An image previews as the shell's thumbnail, a PDF as its first page. */
  kind: 'image' | 'pdf'
  /** The rendered width (CSS px), for the render bucket. */
  width: number
  /**
   * A URL parameter naming the file's version (`v=…`), so a file rewritten at
   * the same path gets a new URL. Omit when the version is unknown.
   */
  version?: string | undefined
  /** Rendered in place of the image once every source has failed. */
  fallback: ReactNode
  onLoadSize?: ((width: number, height: number) => void) | undefined
  /** Every source failed. */
  onError?: (() => void) | undefined
}

type Stage = 'thumbnail' | 'raster' | 'failed'

/**
 * A passive preview of an attachment, for card galleries. An image loads as
 * the shell's cached thumbnail (small, already upright), falls back to the
 * webview decoding the file itself through the raster filter when the shell
 * cannot thumbnail it, and to `fallback` when that fails too; a PDF loads as
 * its first page. Lazy, so only previews near the viewport fetch. A new
 * source — another file, or a `version` naming a rewrite — gets a fresh try.
 */
export function AttachmentPreviewImage({
  generation,
  path,
  kind,
  width,
  version,
  fallback,
  onLoadSize,
  onError,
}: AttachmentPreviewImageProps): ReactElement {
  // Starts over whenever the source changes (another file, a new version),
  // so a reused instance never keeps an earlier source's failure.
  const source = `${generation}:${kind}:${path}:${version ?? ''}`
  const [progress, setProgress] = useState<{ source: string; stage: Stage }>({
    source,
    stage: 'thumbnail',
  })
  if (progress.source !== source) {
    setProgress({ source, stage: 'thumbnail' })
  }
  const stage = progress.source === source ? progress.stage : 'thumbnail'
  const setStage = (next: Stage): void => setProgress({ source, stage: next })
  if (stage === 'failed') {
    return <>{fallback}</>
  }
  const pixels = width * window.devicePixelRatio
  const url =
    kind === 'pdf'
      ? pdfPageUrl(generation, path, 1, pdfPageWidthBucket(pixels))
      : stage === 'raster'
        ? // Held to the thumbnail budget: an image refused a thumbnail for its
          // size is refused here too, never decoded in full for a card.
          `${attachmentUrl(generation, path)}?reflect-preview=raster&budget=thumb`
        : imageThumbnailUrl(generation, path, imageThumbnailWidthBucket(pixels))
  return (
    <img
      src={version === undefined ? url : `${url}&${version}`}
      alt=""
      loading="lazy"
      decoding="async"
      draggable={false}
      onLoad={(event) =>
        onLoadSize?.(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight)
      }
      onError={() => {
        if (kind === 'image' && stage === 'thumbnail') {
          setStage('raster')
        } else {
          setStage('failed')
          onError?.()
        }
      }}
      className={cn(
        'size-full object-cover transition-transform duration-200 group-hover/card:scale-[1.02]',
        kind === 'pdf' && 'object-top',
      )}
    />
  )
}
