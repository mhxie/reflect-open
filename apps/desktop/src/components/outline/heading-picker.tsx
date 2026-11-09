import { useRef, type ReactElement } from 'react'
import { Autocomplete } from '@base-ui/react/autocomplete'
import { SearchIcon } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.tsx'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group.tsx'
import { noteEditorHandleFor } from '@/editor/editor-handle-registry.ts'
import { outlineDepths, outlineHeadingKey } from '@/editor/outline/outline-headings.ts'
import { useNoteOutline } from '@/editor/outline/outline-store.ts'
import type { CommandContext } from '@/lib/commands/types.ts'
import { cn } from '@/lib/utils.ts'
import { useHeadingPicker } from '@/providers/heading-picker-provider.tsx'

interface HeadingPickerProps {
  /** The command capabilities (the same context the palette runs with). */
  context: CommandContext
}

/** Left margin per indent depth; index = depth. */
const DEPTH_MARGIN = ['ml-0', 'ml-3', 'ml-6', 'ml-9'] as const

interface HeadingItem {
  value: string
  label: string
  index: number
}

/**
 * "Jump to heading…": the keyboard face of the note outline. Choosing a
 * heading jumps as its Outline row does; Escape returns focus to the editor.
 */
export function HeadingPicker({ context }: HeadingPickerProps): ReactElement {
  const { open, closeHeadingPicker } = useHeadingPicker()
  // The note the command targeted, read while the picker is open.
  const outline = useNoteOutline(open ? context.notePath() : null)
  const jumpedRef = useRef(false)
  const headings = outline?.headings ?? []
  const depths = outlineDepths(headings)
  // Match only the heading text; positions keep duplicate headings distinct.
  const items: HeadingItem[] = headings.map((heading, index) => ({
    value: outlineHeadingKey(heading),
    label: heading.text,
    index,
  }))

  const jump = (index: number): void => {
    jumpedRef.current = true
    closeHeadingPicker()
    outline?.reveal(index)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          closeHeadingPicker()
        }
      }}
    >
      <DialogContent
        className="top-1/3 translate-y-0 overflow-hidden rounded-xl! p-0"
        showCloseButton={false}
        finalFocus={() => {
          // A jump already focused the editor at the heading; the default return
          // to the previously focused element would take focus back off it.
          if (jumpedRef.current) {
            jumpedRef.current = false
            return false
          }
          // Dismissed: back to the note's editor, caret where it was. The picker
          // opens from the palette, whose input is gone by now, so the default
          // return target would leave focus on <body>.
          const target = context.notePath()
          const editor = target === null ? null : noteEditorHandleFor(target)
          if (editor === null) {
            return true
          }
          editor.focus()
          return false
        }}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>Jump to heading</DialogTitle>
          <DialogDescription>Choose a heading to bring to the top of the note</DialogDescription>
        </DialogHeader>
        <Autocomplete.Root
          inline
          open
          items={items}
          itemToStringValue={(item: HeadingItem) => item.label}
          autoHighlight="always"
          keepHighlight
        >
          <div className="flex flex-col bg-popover p-1 text-popover-foreground">
            <div className="p-1 pb-0">
              <InputGroup className="h-8! rounded-lg! border-input/30 bg-input/30 shadow-none! *:data-[slot=input-group-addon]:pl-2!">
                <Autocomplete.Input
                  aria-label="Jump to heading"
                  placeholder="Jump to heading…"
                  render={<InputGroupInput />}
                />
                <InputGroupAddon>
                  <SearchIcon className="size-4 shrink-0 opacity-50" />
                </InputGroupAddon>
              </InputGroup>
            </div>
            <Autocomplete.Empty className="py-6 text-center text-sm">
              {headings.length === 0 ? 'No headings' : 'No matching headings'}
            </Autocomplete.Empty>
            <Autocomplete.List className="max-h-72 scroll-py-1 overflow-y-auto p-1 scrollbar-none">
              {(item: HeadingItem) => (
                <Autocomplete.Item
                  key={item.value}
                  value={item}
                  onClick={() => jump(item.index)}
                  className="relative flex cursor-default items-center gap-2 rounded-lg px-2 py-1.5 text-sm outline-hidden select-none data-highlighted:bg-surface-hover data-highlighted:text-foreground"
                >
                  <span className={cn('truncate', DEPTH_MARGIN[depths[item.index] ?? 0])}>
                    {item.label}
                  </span>
                </Autocomplete.Item>
              )}
            </Autocomplete.List>
          </div>
        </Autocomplete.Root>
      </DialogContent>
    </Dialog>
  )
}
