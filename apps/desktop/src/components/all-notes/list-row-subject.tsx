import type { ReactElement, ReactNode } from 'react'
import { cn } from '@/lib/utils.ts'
import type { ModClickEvent } from '@/lib/windows/open-in-new-window.ts'

interface ListRowSubjectProps {
  path: string
  onOpen: (path: string, event?: ModClickEvent) => void
  /** Text color and any extra classes; the row owns selection colors. */
  className?: string | undefined
  children: ReactNode
}

/** A {@link ListRow}'s subject: one click opens its note. */
export function ListRowSubject({
  path,
  onOpen,
  className,
  children,
}: ListRowSubjectProps): ReactElement {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation()
        // A browser double-click emits click, click, dblclick. The first
        // click already opens; suppress repeats so modifier-double-click
        // cannot race multiple native opens for the same window.
        if (event.detail > 1) {
          return
        }
        onOpen(path, event)
      }}
      onDoubleClick={(event) => event.stopPropagation()}
      className={cn(
        'truncate text-left text-[13px] font-medium focus-visible:outline-none',
        className,
      )}
    >
      {children}
    </button>
  )
}
