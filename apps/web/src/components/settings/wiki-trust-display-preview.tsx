import type { ReactElement } from 'react'
import type { WikiTrustDisplay } from '@reflect/core'
import { cn } from '@/lib/utils.ts'

interface PreviewProps {
  readonly value: WikiTrustDisplay
}

/** Two lines of placeholder prose with the option's mark, drawn in CSS. */
export function WikiTrustDisplayPreview({ value }: PreviewProps): ReactElement {
  return (
    <span aria-hidden className="relative flex w-full flex-col gap-1 py-1 pr-3">
      {value === 'margin' ? (
        <span className="absolute top-0.5 right-0 size-1.5 rounded-full border border-dashed border-trust-needs-work" />
      ) : null}
      <span className="flex items-center gap-1">
        <span
          className={cn(
            'h-1 flex-1 rounded-full bg-border-strong',
            value === 'on-demand' && 'bg-trust-needs-work/45',
          )}
        />
        {value === 'inline' ? (
          <span className="size-1.5 shrink-0 rounded-full border border-dashed border-trust-needs-work" />
        ) : null}
      </span>
      <span className="h-1 w-3/4 rounded-full bg-border-strong" />
    </span>
  )
}
