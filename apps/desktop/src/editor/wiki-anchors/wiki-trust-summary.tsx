import { useRef, type ReactElement } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import { useNoteArticle } from './wiki-article-store.ts'

interface WikiTrustSummaryProps {
  readonly path: string | null
}

/**
 * The note footer's one trust signal: how many claims need work, and a
 * press that steps through them. Silent when nothing needs attention, so a
 * sound article adds no chrome.
 */
export function WikiTrustSummary({ path }: WikiTrustSummaryProps): ReactElement | null {
  const article = useNoteArticle(path)
  const step = useRef(-1)
  const summary = article?.trust ?? null
  if (article === null || summary === null) return null
  const { counts, needsWork } = summary
  const label =
    needsWork.length > 0
      ? `${needsWork.length} need${needsWork.length === 1 ? 's' : ''} work`
      : counts.pending > 0
        ? `${counts.pending} awaiting evaluation`
        : null
  if (label === null) return null
  const next = (): void => {
    if (needsWork.length === 0) return
    step.current = (step.current + 1) % needsWork.length
    const id = needsWork[step.current]
    if (id !== undefined) article.focusClaim(id)
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={next}
            disabled={needsWork.length === 0}
            className="pointer-events-auto inline-flex h-6 shrink-0 items-center gap-1.5 rounded px-1.5 text-text-muted hover:bg-surface-active hover:text-text focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none disabled:hover:bg-transparent disabled:hover:text-text-muted"
          >
            <span
              aria-hidden
              className={
                needsWork.length > 0
                  ? 'size-2 rounded-full border border-dashed border-trust-needs-work'
                  : 'size-2 rounded-full border border-dotted border-text-muted'
              }
            />
            {label}
          </button>
        }
      />
      <TooltipContent side="top">
        {needsWork.length > 0
          ? 'Go to the next claim that needs work'
          : 'These claims changed since your harness last evaluated them'}
      </TooltipContent>
    </Tooltip>
  )
}
