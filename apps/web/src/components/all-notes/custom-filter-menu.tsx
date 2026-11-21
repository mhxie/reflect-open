import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { foldTag, isTagName, type NoteTagFacet } from '@reflect/core'
import { ArrowLeft, Pin, Settings2 } from 'lucide-react'
import { isPinnedTagDragEscape } from '@/components/tag-filters/cancel-pinned-tag-drag.ts'
import { Button } from '@/components/ui/button.tsx'
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from '@/components/ui/combobox.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import { cn } from '@/lib/utils.ts'

interface CustomFilterMenuProps {
  /** Selectable tags, with non-daily note counts. */
  facets: NoteTagFacet[]
  /** The active tag when it isn't pinned (the menu owns it), else null. */
  activeTag: string | null
  onSelect: (tag: string) => void
  /** The trigger's label while no tag is active. */
  label?: string
  /** Optional All Notes preference editor; other tag pickers keep selection only. */
  management?: ReactNode
  /** Tags already available as tabs, labelled in the picker when management is enabled. */
  pinnedTags?: readonly string[]
  /** Pin the active custom tag without changing the selected filter. */
  onPinCurrent?: (() => void) | undefined
}

/**
 * The filter group's last segment: a combobox with its search input inside
 * the popup. All Notes can add a pinned-filter editor to the same popup.
 * The search input doubles as free entry — typing
 * any valid tag name offers a "Filter by #tag" item, so the filter isn't
 * limited to tags the facet query happened to return.
 */
export function CustomFilterMenu({
  facets,
  activeTag,
  onSelect,
  label = 'Custom',
  management,
  pinnedTags = [],
  onPinCurrent,
}: CustomFilterMenuProps): ReactElement {
  const [open, setOpen] = useState(false)
  const [managing, setManaging] = useState(false)
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const managerRef = useRef<HTMLDivElement>(null)
  const pinnedKeys = new Set(pinnedTags.map(foldTag))

  useEffect(() => {
    if (open) {
      const input = managing ? managerRef.current?.querySelector('input') : inputRef.current
      input?.focus({ preventScroll: true })
    }
  }, [open, managing])

  const choose = (tag: string): void => {
    setOpen(false)
    setQuery('')
    setManaging(false)
    onSelect(tag)
  }

  // Accept "#book" as readily as "book" — the UI renders tags hash-prefixed,
  // so people type them that way too. Same parsing as the pinned-filter editor.
  const typed = query.trim().replace(/^#+/, '').trim()
  const typedKey = foldTag(typed)
  const counts = new Map(facets.map((facet) => [foldTag(facet.tag), facet.count]))
  const offerTyped = typed !== '' && !counts.has(typedKey) && isTagName(typed)
  const tags = facets.map((facet) => facet.tag)

  let emptyMessage = 'No matching tags.'
  if (typed === '') {
    emptyMessage = 'Type a tag to filter by.'
  } else if (!isTagName(typed)) {
    emptyMessage = 'Not a valid tag name.'
  }

  const trigger = (
    <ComboboxTrigger
      {...(management === undefined ? {} : { render: <TooltipTrigger /> })}
      aria-pressed={activeTag !== null}
      aria-label={activeTag !== null ? `#${activeTag}` : label}
      className={cn(
        'flex h-full items-center gap-1 px-3 py-1.5 text-[13px] font-medium transition-colors duration-100',
        management !== undefined && 'max-w-28 shrink-0 rounded-r-lg @3xl/all-notes:max-w-40',
        activeTag !== null
          ? 'bg-surface-hover text-text'
          : 'text-text-secondary hover:bg-surface-hover hover:text-text',
      )}
    >
      <span className={cn(management !== undefined && 'min-w-0 truncate')}>
        {activeTag !== null ? `#${activeTag}` : label}
      </span>
    </ComboboxTrigger>
  )

  return (
    <Combobox
      items={offerTyped ? [...tags, typed] : tags}
      itemToStringLabel={(tag: string) => `#${tag}`}
      isItemEqualToValue={(tag: string, value: string) => foldTag(tag) === foldTag(value)}
      filter={(tag: string) => foldTag(tag).includes(typedKey)}
      value={activeTag}
      onValueChange={(tag: string | null) => {
        if (tag !== null) choose(tag)
      }}
      inputValue={query}
      onInputValueChange={setQuery}
      autoHighlight
      open={open}
      onOpenChange={(next, details) => {
        if (
          !next &&
          management !== undefined &&
          details.reason === 'escape-key' &&
          isPinnedTagDragEscape(details.event)
        ) {
          details.cancel()
          details.allowPropagation()
          return
        }
        setOpen(next)
        if (!next) {
          setQuery('')
          setManaging(false)
        }
      }}
    >
      {management === undefined ? (
        trigger
      ) : (
        <Tooltip>
          {trigger}
          <TooltipContent>
            {activeTag !== null ? `#${activeTag}` : 'Custom tag filters'}
          </TooltipContent>
        </Tooltip>
      )}
      <ComboboxContent
        align="end"
        sideOffset={6}
        aria-label={managing ? 'Pinned filters' : 'Filter by another tag'}
        className={cn(
          'max-h-(--available-height) max-w-[calc(100vw-1.5rem)] overflow-y-auto',
          management !== undefined ? 'w-80 p-1' : 'w-56',
        )}
      >
        {managing ? (
          <div ref={managerRef} className="flex min-h-0 flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[13px] font-medium">Pinned filters</span>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Back to tag filters"
                onClick={() => setManaging(false)}
              >
                <ArrowLeft aria-hidden className="size-3.5" />
              </Button>
            </div>
            {management}
            <div className="flex justify-end">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setOpen(false)
                  setManaging(false)
                  setQuery('')
                }}
              >
                Done
              </Button>
            </div>
          </div>
        ) : (
          <>
            {activeTag !== null && onPinCurrent !== undefined ? (
              <Button
                type="button"
                variant="ghost"
                className="w-full justify-start text-text-secondary"
                onClick={() => {
                  onPinCurrent()
                  setOpen(false)
                  setQuery('')
                }}
              >
                <Pin aria-hidden className="size-3.5" />
                <span className="min-w-0 truncate">Pin #{activeTag}</span>
              </Button>
            ) : null}
            <ComboboxInput
              ref={inputRef}
              showTrigger={false}
              aria-label="Filter by another tag"
              placeholder="Filter by any tag…"
            />
            <ComboboxEmpty>{emptyMessage}</ComboboxEmpty>
            <ComboboxList>
              {(tag: string) => {
                const count = counts.get(foldTag(tag))
                return (
                  <ComboboxItem key={foldTag(tag)} value={tag}>
                    {count === undefined ? (
                      <span className="min-w-0 flex-1 truncate">Filter by #{tag}</span>
                    ) : (
                      <>
                        <span className="min-w-0 flex-1 truncate">#{tag}</span>
                        <span className="shrink-0 text-xs tabular-nums text-text-muted">
                          {pinnedKeys.has(foldTag(tag)) ? 'Pinned · ' : ''}
                          {count}
                        </span>
                      </>
                    )}
                  </ComboboxItem>
                )
              }}
            </ComboboxList>
            {management !== undefined ? (
              <Button
                type="button"
                variant="ghost"
                className="w-full justify-start border-t border-border text-text-secondary"
                onClick={() => {
                  setManaging(true)
                  setQuery('')
                }}
              >
                <Settings2 aria-hidden className="size-3.5" />
                Manage pinned filters…
              </Button>
            ) : null}
          </>
        )}
      </ComboboxContent>
    </Combobox>
  )
}
