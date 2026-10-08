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
  const { needsWork, pending } = summary
  if (needsWork.length === 0) {
    if (pending === 0) return null
    // Nothing to step to, so plain text whose words carry the meaning.
    return (
      <span
        title="Hold ⌥ to see every claim"
        className="inline-flex h-6 shrink-0 items-center gap-1.5 px-1.5 text-text-muted"
      >
        <span aria-hidden className="wiki-trust-glyph" data-wiki-trust="pending" />
        {pending} not yet evaluated
      </span>
    )
  }
  const next = (): void => {
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
            className="pointer-events-auto inline-flex h-6 shrink-0 items-center gap-1.5 rounded px-1.5 text-text-muted hover:bg-surface-active hover:text-text focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
          >
            <span aria-hidden className="wiki-trust-glyph" data-wiki-trust="needs-work" />
            {needsWork.length} need{needsWork.length === 1 ? 's' : ''} work
          </button>
        }
      />
      <TooltipContent side="top">
        Next claim that needs work · Hold ⌥ to see every claim
      </TooltipContent>
    </Tooltip>
  )
}
