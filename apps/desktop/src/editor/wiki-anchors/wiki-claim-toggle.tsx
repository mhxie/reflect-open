import type { ReactElement } from 'react'
import { ScanText } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import { useNoteArticle } from './wiki-article-store.ts'

interface WikiClaimToggleProps {
  readonly path: string | null
}

/** A view-only control in the existing note chrome. */
export function WikiClaimToggle({ path }: WikiClaimToggleProps): ReactElement | null {
  const article = useNoteArticle(path)
  if (article === null || !article.index.article) return null
  const label = article.showRanges ? 'Hide claim ranges' : 'Show claim ranges'
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            aria-pressed={article.showRanges}
            onClick={article.toggleRanges}
            className="pointer-events-auto inline-flex size-6 shrink-0 items-center justify-center rounded text-text-muted hover:bg-surface-active hover:text-text focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none aria-pressed:text-text"
          >
            <ScanText aria-hidden className="size-4" />
          </button>
        }
      />
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  )
}
