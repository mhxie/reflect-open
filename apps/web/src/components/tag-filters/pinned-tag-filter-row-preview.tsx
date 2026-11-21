import type { ReactElement } from 'react'
import { GripVertical } from 'lucide-react'

interface PinnedTagFilterRowPreviewProps {
  readonly tag: string
}

/** The noninteractive, lifted copy of a tag while its handle is being dragged. */
export function PinnedTagFilterRowPreview({ tag }: PinnedTagFilterRowPreviewProps): ReactElement {
  return (
    <div
      aria-hidden
      className="flex items-center gap-2 rounded-lg border border-border-strong bg-popover px-1.5 py-1 text-[13px] text-text shadow-lg"
    >
      <span className="flex size-7 shrink-0 items-center justify-center text-text-muted">
        <GripVertical aria-hidden className="size-3.5" strokeWidth={1.75} />
      </span>
      <span className="min-w-0 flex-1 truncate">#{tag}</span>
    </div>
  )
}
