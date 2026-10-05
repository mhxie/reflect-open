import { useRef, type ReactElement } from 'react'
import { defaultFilter } from 'cmdk'
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command.tsx'
import { noteEditorHandleFor } from '@/editor/editor-handle-registry.ts'
import { outlineDepths } from '@/editor/outline/outline-headings.ts'
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

/**
 * Rows match on the heading text alone (their keywords). Values carry the
 * heading's editor position only to keep duplicate headings distinct rows,
 * and must not make a digit query match every row.
 */
function matchHeadingText(_value: string, search: string, keywords?: string[]): number {
  return defaultFilter(keywords?.join(' ') ?? '', search)
}

/**
 * "Jump to heading…": the keyboard face of the note outline. Choosing a
 * heading jumps as its Outline row does; Escape returns focus to the editor.
 */
export function HeadingPicker({ context }: HeadingPickerProps): ReactElement {
  const { open, closeHeadingPicker } = useHeadingPicker()
  // The note the command targeted, read while the picker is open.
  const outline = useNoteOutline(open ? context.notePath() : null)
  const jumped = useRef(false)
  const headings = outline?.headings ?? []
  const depths = outlineDepths(headings)

  const jump = (index: number): void => {
    jumped.current = true
    closeHeadingPicker()
    outline?.reveal(index)
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          closeHeadingPicker()
        }
      }}
      finalFocus={() => {
        // A jump already focused the editor at the heading; the default return
        // to the previously focused element would take focus back off it.
        if (jumped.current) {
          jumped.current = false
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
      title="Jump to heading"
      description="Choose a heading to bring to the top of the note"
    >
      <Command filter={matchHeadingText}>
        <CommandInput placeholder="Jump to heading…" />
        <CommandList>
          <CommandEmpty>
            {headings.length === 0 ? 'No headings' : 'No matching headings'}
          </CommandEmpty>
          {headings.length > 0 ? (
            <CommandGroup>
              {headings.map((heading, index) => (
                <CommandItem
                  key={heading.embedded?.key ?? heading.position}
                  value={`heading-${heading.embedded?.key ?? heading.position}`}
                  keywords={[heading.text]}
                  onSelect={() => jump(index)}
                >
                  <span className={cn('truncate', DEPTH_MARGIN[depths[index] ?? 0])}>
                    {heading.text}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}
        </CommandList>
      </Command>
    </CommandDialog>
  )
}
