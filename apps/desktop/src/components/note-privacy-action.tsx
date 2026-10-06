import type { ReactElement } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Shield } from 'lucide-react'
import { useUnreadableFrontmatter } from '@/hooks/use-unreadable-frontmatter.ts'
import { toggleNotePrivate, UNREADABLE_FRONTMATTER_HINT } from '@/lib/note-private.ts'
import { cn } from '@/lib/utils.ts'
import { useGraph } from '@/providers/graph-provider.tsx'
import { DropdownMenuCheckboxItem } from '@/components/ui/dropdown-menu.tsx'
import { NOTE_MENU_ITEM, NoteMenuItemContent } from './note-menu-row.tsx'

interface NotePrivacyActionProps {
  /** Graph-relative path of a note whose privacy is its `private` frontmatter flag. */
  readonly path: string
  readonly isPrivate: boolean
  /** What being private means, under the row while it is checked. */
  readonly hint: string | null
}

/**
 * "Private" as a checkbox menu item, through the same {@link toggleNotePrivate}
 * as the command and the context sidebar (which offers Undo). A note whose
 * frontmatter can't be read stays locked and says how to fix it.
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
    <DropdownMenuCheckboxItem
      checked={isPrivate}
      disabled={unreadable}
      onCheckedChange={() => void toggle()}
      className={cn(NOTE_MENU_ITEM, 'text-text data-disabled:opacity-60')}
    >
      <NoteMenuItemContent
        icon={<Shield className={isPrivate ? 'text-note-state-private' : 'text-text-muted'} />}
        label="Private"
        hint={unreadable ? UNREADABLE_FRONTMATTER_HINT : isPrivate ? hint : null}
      />
    </DropdownMenuCheckboxItem>
  )
}
