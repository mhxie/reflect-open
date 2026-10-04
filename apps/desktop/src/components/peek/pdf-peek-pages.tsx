import type { ReactElement } from 'react'
import { useQuery } from '@tanstack/react-query'
import { pdfPageWidthBucket } from '@reflect/core'
import { pdfPageUrl } from '@/editor/use-note-attachments.ts'
import { useElementWidth } from '@/hooks/use-element-width.ts'
import { createPdfInfoQueryOptions } from '@/lib/query-options.ts'

/**
 * A PDF read in Peek: every page at the panel's width, stacked, loading as it
 * scrolls near. Sizes come from the same `pdf_info` query the inline preview
 * uses, so each page reserves its box before its raster arrives.
 */
export function PdfPeekPages({
  generation,
  path,
}: {
  generation: number
  path: string
}): ReactElement {
  const [measure, width] = useElementWidth()
  const { data, error } = useQuery(createPdfInfoQueryOptions(generation, path, undefined))
  const bucket = pdfPageWidthBucket(width * window.devicePixelRatio)

  return (
    <div ref={measure} className="min-h-0 flex-1 overflow-auto bg-surface-sunken px-6 py-6">
      {error !== null ? (
        <p className="py-10 text-center text-xs text-text-muted">This PDF couldn’t be previewed.</p>
      ) : (
        <div className="mx-auto flex max-w-full flex-col gap-4">
          {data?.pages.map((page, index) => (
            <img
              // Pages never reorder; the page number is the identity.
              key={index + 1}
              alt={`Page ${index + 1}`}
              loading="lazy"
              src={pdfPageUrl(generation, path, index + 1, bucket)}
              width={page.width}
              height={page.height}
              className="h-auto w-full rounded-sm bg-white shadow-sm"
            />
          ))}
        </div>
      )}
    </div>
  )
}
