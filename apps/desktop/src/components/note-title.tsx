import type { ReactElement } from 'react'
import { noteTitlePresentation, type NoteTitleMetadata } from '@reflect/core'
import { cn } from '@/lib/utils.ts'

interface NoteTitleProps extends NoteTitleMetadata {
  title: string
  className?: string
  wrap?: boolean
}

/** One title presentation across lists, search, backlinks and note chrome. */
export function NoteTitle({
  title,
  displayTitle,
  lang,
  className,
  wrap = false,
}: NoteTitleProps): ReactElement {
  const presentation = noteTitlePresentation(title, { displayTitle, lang })
  return (
    <span
      className={cn(wrap ? 'inline' : 'inline-flex min-w-0 items-baseline gap-1', className)}
      aria-label={
        presentation.language ? `${presentation.text}，${presentation.language}` : undefined
      }
    >
      <span className={wrap ? undefined : 'truncate'}>{presentation.text}</span>
      {presentation.language && (
        <sup
          className={cn(
            'relative -top-1 shrink-0 text-[10px] font-normal leading-none text-text-muted',
            wrap && 'ml-1',
          )}
          aria-hidden
        >
          {presentation.language}
        </sup>
      )}
    </span>
  )
}
