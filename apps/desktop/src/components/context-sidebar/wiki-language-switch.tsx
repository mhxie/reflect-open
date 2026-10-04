import type { MouseEvent, ReactElement } from 'react'
import { isModEvent } from '@meowdown/core'
import { Languages } from 'lucide-react'
import { useNoteLinkNavigation } from '@/hooks/use-note-link-navigation.ts'
import { useWikiCopies } from '@/hooks/use-wiki-copies.ts'
import { cn } from '@/lib/utils.ts'
import { routeForPath } from '@/routing/route.ts'

interface WikiLanguageSwitchProps {
  /** Graph-relative path of the open note. */
  path: string
}

/**
 * A wiki entry's languages (Settings → Wiki) on one line: the copy being read,
 * pressed; the others it exists in, one click (⌘-click: a new window) away;
 * those it doesn't, dimmed. Renders nothing for a note outside the wiki.
 */
export function WikiLanguageSwitch({ path }: WikiLanguageSwitchProps): ReactElement | null {
  const copies = useWikiCopies(path)
  const navigateNoteLink = useNoteLinkNavigation()
  if (copies === undefined) {
    return null
  }

  return (
    <div className="flex items-center gap-2 px-3.5">
      <Languages aria-hidden className="size-3.5 flex-none text-text-muted" />
      <div
        role="group"
        aria-label="Language"
        className="flex min-w-0 flex-1 items-stretch divide-x divide-border overflow-hidden rounded-md border border-border bg-surface shadow-sm"
      >
        {copies.map(({ language, path: copy }) => {
          const current = copy === path
          return (
            <button
              key={language.folder}
              type="button"
              disabled={copy === null}
              aria-pressed={current}
              aria-label={copy === null ? `${language.label}, not translated` : language.label}
              onClick={(event: MouseEvent) => {
                if (copy !== null && !current) {
                  navigateNoteLink({
                    target: routeForPath(copy),
                    openInNewWindow: isModEvent(event),
                  })
                }
              }}
              className={cn(
                'min-w-0 flex-1 truncate px-2 py-1 text-xs font-medium transition-colors duration-100',
                current
                  ? 'bg-surface-hover text-text'
                  : 'text-text-secondary enabled:hover:bg-surface-hover enabled:hover:text-text',
                copy === null && 'cursor-default opacity-40',
              )}
            >
              {language.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
