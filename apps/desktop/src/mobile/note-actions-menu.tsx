import { useState, type ReactElement } from 'react'
import { MoreHorizontal, Pin, PinOff, Share, Shield, ShieldOff, Trash2 } from 'lucide-react'
import { errorMessage, isLocalOnlyPath } from '@reflect/core'
import { Button } from '@/components/ui/button.tsx'
import { Drawer, DrawerContent, DrawerTitle, DrawerTrigger } from '@/components/ui/drawer.tsx'
import { useNoteRowState } from '@/hooks/use-note-row.ts'
import { usePinnedNotes } from '@/hooks/use-pinned-notes.ts'
import { useUnreadableFrontmatter } from '@/hooks/use-unreadable-frontmatter.ts'
import { useQueryClient } from '@tanstack/react-query'
import { toggleNotePinned } from '@/lib/note-pin.ts'
import { toggleNotePrivate, UNREADABLE_FRONTMATTER_LABEL } from '@/lib/note-private.ts'
import { NoteDeleteDrawer } from '@/mobile/note-delete-drawer.tsx'
import { shareNote } from '@/mobile/share.ts'
import { useGraph } from '@/providers/graph-provider.tsx'

interface NoteActionsMenuProps {
  /** Graph-relative path of the note the actions operate on. */
  path: string
  /** Called after the note is deleted, so the screen can navigate away. */
  onDeleted: () => void
}

/**
 * The note screen's "⋯" action sheet (Plan 19): pin/unpin, privacy,
 * share, and delete-to-trash. Pin reflects the index's
 * pinned set; privacy reflects the note's indexed `private: true` flag,
 * both updated in the shared query cache while the index catches up (a note
 * whose frontmatter can't be read shows as locked, with the toggle
 * disabled). {@link shareNote} hands the note's body to the OS share sheet via
 * the Web Share API (`navigator.share`); delete confirms first (it's
 * destructive, even if recoverable from `.reflect/trash/`) and routes through
 * {@link deleteOpenNote} so the open session is discarded rather than flushed.
 */
export function NoteActionsMenu({ path, onDeleted }: NoteActionsMenuProps): ReactElement {
  const { graph } = useGraph()
  const queryClient = useQueryClient()
  const isPinned = usePinnedNotes().some((note) => note.path === path)
  const { row: noteRow, settled: privacyReady } = useNoteRowState(path)
  const [actionsOpen, setActionsOpen] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const isPrivate = noteRow?.isPrivate ?? false
  const localOnly = isLocalOnlyPath(path)
  const unreadable = useUnreadableFrontmatter(path, isPrivate)
  const privacyActionLabel = !privacyReady
    ? 'Loading privacy…'
    : unreadable
      ? UNREADABLE_FRONTMATTER_LABEL
      : isPrivate
        ? 'Make this note standard'
        : 'Make this note private'

  const pin = (): void => {
    if (graph !== null) {
      void toggleNotePinned({
        queryClient,
        root: graph.root,
        generation: graph.generation,
        path,
      })
    }
  }

  const togglePrivate = async (): Promise<void> => {
    if (graph !== null) {
      await toggleNotePrivate({ queryClient, root: graph.root, generation: graph.generation, path })
    }
  }

  const share = (): void => {
    void shareNote(path).catch((cause) => console.error('share failed:', errorMessage(cause)))
  }

  return (
    <>
      <Drawer open={actionsOpen} onOpenChange={setActionsOpen}>
        <DrawerTrigger
          render={
            <Button variant="ghost" size="icon" className="size-10" aria-label="Note actions" />
          }
        >
          <MoreHorizontal />
        </DrawerTrigger>
        <DrawerContent>
          <DrawerTitle className="sr-only">Note actions</DrawerTitle>
          <div className="flex flex-col gap-1 p-4">
            <Button
              variant="ghost"
              size="lg"
              className="h-12 justify-start gap-3 text-base"
              onClick={() => {
                pin()
                setActionsOpen(false)
              }}
            >
              {isPinned ? <PinOff /> : <Pin />}
              {isPinned ? 'Unpin' : 'Pin'}
            </Button>
            {localOnly ? null : (
              <Button
                variant="ghost"
                size="lg"
                className="h-12 justify-start gap-3 text-base"
                disabled={!privacyReady || unreadable}
                onClick={() => {
                  void togglePrivate()
                  setActionsOpen(false)
                }}
              >
                {privacyReady && isPrivate && !unreadable ? (
                  <ShieldOff aria-hidden />
                ) : (
                  <Shield aria-hidden />
                )}
                {privacyActionLabel}
              </Button>
            )}
            <Button
              variant="ghost"
              size="lg"
              className="h-12 justify-start gap-3 text-base"
              onClick={() => {
                share()
                setActionsOpen(false)
              }}
            >
              <Share />
              Share
            </Button>
            <Button
              variant="ghost"
              size="lg"
              className="h-12 justify-start gap-3 text-base text-destructive hover:text-destructive"
              onClick={() => {
                setActionsOpen(false)
                setConfirmingDelete(true)
              }}
            >
              <Trash2 />
              Delete
            </Button>
          </div>
        </DrawerContent>
      </Drawer>

      <NoteDeleteDrawer
        path={path}
        open={confirmingDelete}
        onOpenChange={setConfirmingDelete}
        onDeleted={onDeleted}
      />
    </>
  )
}
