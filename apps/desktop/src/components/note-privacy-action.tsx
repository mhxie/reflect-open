import type { ReactElement } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Shield, ShieldOff } from 'lucide-react'
import { useUnreadableFrontmatter } from '@/hooks/use-unreadable-frontmatter.ts'
import { toggleNotePrivate, UNREADABLE_FRONTMATTER_HINT } from '@/lib/note-private.ts'
import { useGraph } from '@/providers/graph-provider.tsx'
import { Button } from '@/components/ui/button.tsx'

interface NotePrivacyActionProps {
  /** Graph-relative path of a note whose privacy is its `private` frontmatter flag. */
  readonly path: string
  readonly isPrivate: boolean
}

/**
 * The privacy toggle next to the state it changes, through the same
 * {@link toggleNotePrivate} as the command and the context sidebar. A note
 * whose frontmatter can't be read stays locked and says how to fix it.
 */
export function NotePrivacyAction({ path, isPrivate }: NotePrivacyActionProps): ReactElement {
  const { graph } = useGraph()
  const queryClient = useQueryClient()
  const unreadable = useUnreadableFrontmatter(path, isPrivate)

  const toggle = async (): Promise<void> => {
    if (graph !== null) {
      await toggleNotePrivate({ queryClient, root: graph.root, generation: graph.generation, path })
    }
  }

  return (
    <div className="space-y-1">
      <Button
        size="sm"
        variant="outline"
        className="w-full"
        disabled={unreadable}
        onClick={() => void toggle()}
      >
        {isPrivate ? <ShieldOff aria-hidden /> : <Shield aria-hidden />}
        {isPrivate ? 'Unmark as private' : 'Mark as private'}
      </Button>
      {unreadable ? (
        <p className="text-2xs whitespace-normal text-text-muted">{UNREADABLE_FRONTMATTER_HINT}</p>
      ) : null}
    </div>
  )
}
