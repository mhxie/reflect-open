import type { ReactElement } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Check, Shield } from 'lucide-react'
import { useUnreadableFrontmatter } from '@/hooks/use-unreadable-frontmatter.ts'
import { toggleNotePrivate, UNREADABLE_FRONTMATTER_HINT } from '@/lib/note-private.ts'
import { cn } from '@/lib/utils.ts'
import { useGraph } from '@/providers/graph-provider.tsx'
import { NOTE_MENU_ITEM, NoteMenuHint } from './note-menu-row.tsx'

interface NotePrivacyActionProps {
  /** Graph-relative path of a note whose privacy is its `private` frontmatter flag. */
  readonly path: string
  readonly isPrivate: boolean
  /** What being private means, under the row while it is checked. */
  readonly hint: string | null
}

/**
 * "Private" as a checkable menu row, through the same
 * {@link toggleNotePrivate} as the command and the context sidebar. A note
 * whose frontmatter can't be read stays locked and says how to fix it.
 */
export function NotePrivacyAction({ path, isPrivate, hint }: NotePrivacyActionProps): ReactElement {
  const { graph } = useGraph()
  const queryClient = useQueryClient()
  const unreadable = useUnreadableFrontmatter(path, isPrivate)

  const toggle = async (): Promise<void> => {
    if (graph !== null) {
      await toggleNotePrivate({ queryClient, root: graph.root, generation: graph.generation, path })
    }
  }

  return (
    <>
      <button
        type="button"
        data-note-menu-item
        aria-pressed={isPrivate}
        disabled={unreadable}
        onClick={() => void toggle()}
        className={cn(NOTE_MENU_ITEM, 'text-text disabled:opacity-60')}
      >
        <Shield className={isPrivate ? 'text-note-state-private' : 'text-text-muted'} />
        <span data-testid="note-menu-label" className="flex-1 text-left">
          Private
        </span>
        {isPrivate ? <Check className="text-accent" /> : null}
      </button>
      <NoteMenuHint>
        {unreadable ? UNREADABLE_FRONTMATTER_HINT : isPrivate ? hint : null}
      </NoteMenuHint>
    </>
  )
}
