import type { ReactElement } from 'react'

export interface ActivitySectionTitleProps {
  children: string
}

/** A section heading inside the activity tray. */
export function ActivitySectionTitle({ children }: ActivitySectionTitleProps): ReactElement {
  return (
    <p className="px-3 pt-2 pb-1 text-2xs font-medium tracking-wide text-text-muted uppercase">
      {children}
    </p>
  )
}
