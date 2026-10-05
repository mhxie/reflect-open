import type { ReactElement } from 'react'
import { cn } from '@/lib/utils.ts'

export interface ActivityProgressRingProps {
  /** Share done (0–1), or null when the size of the work is unknown. */
  fraction: number | null
}

/** A 16px ring: filled to `fraction`, or a spinning arc when the size is unknown. */
export function ActivityProgressRing({ fraction }: ActivityProgressRingProps): ReactElement {
  const circumference = 2 * Math.PI * 6
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      className={cn('size-4 -rotate-90', fraction === null && 'motion-safe:animate-spin')}
    >
      <circle cx="8" cy="8" r="6" fill="none" strokeWidth="2" className="stroke-border" />
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        strokeWidth="2"
        strokeLinecap="round"
        className="stroke-accent transition-[stroke-dashoffset] duration-300"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - (fraction ?? 0.25))}
      />
    </svg>
  )
}
