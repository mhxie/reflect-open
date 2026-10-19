import type { ReactElement } from 'react'
import { ExternalLink } from 'lucide-react'
import { useGraph } from '@/providers/graph-provider.tsx'
import { useCoreServices } from '@/services/services-provider.tsx'
import { PEEK_HEADER_BUTTON } from './peek-header-button.ts'
import { PeekFrame } from './peek-frame.tsx'
import { PdfPeekPages } from './pdf-peek-pages.tsx'

export interface PdfPeekProps {
  /** Graph-relative path of the PDF. */
  path: string
  onClose: () => void
}

/**
 * A peeked PDF, read page by page, with a way out to its default app. It
 * takes focus when it opens: it is usually opened from a note's editor, which
 * would otherwise keep receiving keystrokes under the peek.
 */
export function PdfPeek({ path, onClose }: PdfPeekProps): ReactElement {
  const { graph } = useGraph()
  const { attachments } = useCoreServices()
  const generation = graph?.generation ?? null
  return (
    <PeekFrame
      title={path.slice(path.lastIndexOf('/') + 1)}
      onClose={onClose}
      focusOnOpen
      actions={
        generation === null ? null : (
          <button
            type="button"
            aria-label="Open in default app"
            title="Open in default app"
            // A failure surfaces as an "Opening attachment" operation.
            onClick={() => void attachments.openOrReveal(path)}
            className={PEEK_HEADER_BUTTON}
          >
            <ExternalLink aria-hidden className="size-4" strokeWidth={1.75} />
          </button>
        )
      }
    >
      {generation === null ? null : <PdfPeekPages generation={generation} path={path} />}
    </PeekFrame>
  )
}
