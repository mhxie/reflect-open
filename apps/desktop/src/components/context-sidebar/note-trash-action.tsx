import { useState, type ReactElement } from 'react'
import { errorMessage, isDaily, isLocalOnlyPath } from '@reflect/core'
import { Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button.tsx'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog.tsx'
import { deleteOpenNote, KEPT_IN_GRAPH_TRASH } from '@/lib/note-delete.ts'
import { startOperation } from '@/lib/operations.ts'
import { useGraph } from '@/providers/graph-provider.tsx'
import { useRouter } from '@/routing/router.tsx'

interface NoteTrashActionProps {
  /** Graph-relative path of the regular note to move into trash. */
  path: string
}

/**
 * Moves a regular note to the system Trash after confirmation. A note from an
 * editable local-only folder gets there by way of the graph's
 * `.reflect/trash/`, and stays there when the system Trash refuses it, which
 * the status line then says. Daily notes return `null` here as a second
 * UI-layer guard; the shared delete helper enforces the same rule before
 * touching disk.
 */
export function NoteTrashAction({ path }: NoteTrashActionProps): ReactElement | null {
  const { graph } = useGraph()
  const { navigate } = useRouter()
  const [confirmingTrash, setConfirmingTrash] = useState(false)
  const [isTrashing, setIsTrashing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (isDaily(path)) {
    return null
  }

  const onTrash = async (): Promise<void> => {
    const generation = graph?.generation
    if (generation === undefined) {
      return
    }
    const operation = startOperation('Trashing note')
    setIsTrashing(true)
    setError(null)
    try {
      const outcome = await deleteOpenNote(path, generation)
      if (outcome?.trashed === 'graph') {
        operation.warn(KEPT_IN_GRAPH_TRASH)
      } else {
        operation.done()
      }
      setConfirmingTrash(false)
      navigate({ kind: 'today' })
    } catch (cause) {
      const message = errorMessage(cause)
      setError(message)
      operation.fail(message)
    } finally {
      setIsTrashing(false)
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setConfirmingTrash(true)}
        className="group relative flex w-full items-center space-x-2 rounded-lg px-3 py-2 text-start hover:bg-surface-hover"
      >
        <span className="flex h-5 w-5 flex-none items-center justify-center text-text-muted group-hover:text-destructive">
          <Trash2 size={14} aria-hidden />
        </span>
        <span className="min-w-0 flex-1 truncate text-xs font-medium group-hover:text-destructive">
          Trash note
        </span>
      </button>

      <Dialog
        open={confirmingTrash}
        onOpenChange={(open) => !isTrashing && setConfirmingTrash(open)}
      >
        <DialogContent>
          <DialogTitle>Trash this note?</DialogTitle>
          <DialogDescription>
            {isLocalOnlyPath(path)
              ? 'It moves to your system Trash by way of this graph’s .reflect/trash folder. Put Back returns it to that folder, not here.'
              : 'It moves to your system Trash, where you can restore it.'}
          </DialogDescription>
          {error !== null ? <p className="text-sm text-destructive">{error}</p> : null}
          <DialogFooter>
            <DialogClose
              render={
                <Button variant="ghost" disabled={isTrashing}>
                  Cancel
                </Button>
              }
            />
            <Button variant="destructive" disabled={isTrashing} onClick={() => void onTrash()}>
              Trash note
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
