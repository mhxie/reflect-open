import type { MouseEvent, ReactElement } from 'react'
import { isModEvent } from '@meowdown/core'
import { ChevronRight } from 'lucide-react'
import { NoteTitle } from '@/components/note-title.tsx'
import { useNoteLinkNavigation } from '@/hooks/use-note-link-navigation.ts'
import { useWikiAncestors } from '@/hooks/use-wiki-ancestors.ts'
import { cn } from '@/lib/utils.ts'
import { routeForPath } from '@/routing/route.ts'

interface WikiBreadcrumbProps {
  /** Graph-relative path of the open note. */
  path: string
  className?: string
}

/** The trail's line height, held while it loads so the title below doesn't jump. */
const TRAIL_HEIGHT = 'h-5'

/**
 * The indexes above a wiki note, root first, on one quiet line above its H1;
 * each opens in place (⌘-click: a new window). Reading chrome only: nothing is
 * written to the note or counted as a link. Takes no space where no index
 * could sit above the note, or none does.
 */
export function WikiBreadcrumb({ path, className }: WikiBreadcrumbProps): ReactElement | null {
  const state = useWikiAncestors(path)
  const navigateNoteLink = useNoteLinkNavigation()
  if (state.kind === 'loading') {
    return (
      <div aria-hidden data-testid="wiki-path-pending" className={cn(TRAIL_HEIGHT, className)} />
    )
  }
  if (state.kind === 'none' || state.ancestors.length === 0) {
    return null
  }

  return (
    <nav aria-label="Wiki path" className={cn('overflow-x-auto', className)}>
      <ol
        className={cn(
          TRAIL_HEIGHT,
          'flex w-max items-center gap-1 whitespace-nowrap text-[12px] text-text-muted',
        )}
      >
        {state.ancestors.map((ancestor, index) => (
          <li key={ancestor.path} className="flex items-center gap-1">
            {index > 0 ? <ChevronRight aria-hidden className="size-3 flex-none" /> : null}
            <button
              type="button"
              onClick={(event: MouseEvent) =>
                navigateNoteLink({
                  target: routeForPath(ancestor.path),
                  openInNewWindow: isModEvent(event),
                })
              }
              className="rounded-sm transition-colors duration-100 hover:text-text focus-visible:text-text focus-visible:outline-none"
            >
              <NoteTitle
                title={ancestor.title}
                displayTitle={ancestor.displayTitle}
                lang={ancestor.lang}
              />
            </button>
          </li>
        ))}
      </ol>
    </nav>
  )
}
