import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { foldTag, isTagName, type NoteTagFacet } from '@reflect/core'
import { ArrowLeft, ChevronDown, Pin, Settings2 } from 'lucide-react'
import { isPinnedTagDragEscape } from '@/components/tag-filters/cancel-pinned-tag-drag.ts'
import { Button } from '@/components/ui/button.tsx'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command.tsx'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.tsx'
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
 * The filter group's last segment: a combobox (shadcn's Popover + Command
 * pairing). All Notes can add a pinned-filter editor to the same popover.
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
  // so people type them that way too.
  const typed = query.trim().replace(/^#/, '')
  const typedKey = foldTag(typed)
  const listed = facets.some((facet) => foldTag(facet.tag) === typedKey)
  const offerTyped = typed !== '' && !listed && isTagName(typed)

  let emptyMessage = 'No matching tags.'
  if (typed === '') {
    emptyMessage = 'Type a tag to filter by.'
  } else if (!isTagName(typed)) {
    emptyMessage = 'Not a valid tag name.'
  }

  const trigger = (
    <PopoverTrigger
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
      <ChevronDown aria-hidden strokeWidth={1.75} className="size-3.5 shrink-0" />
    </PopoverTrigger>
  )

  return (
    <Popover
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
      <PopoverContent
        align="end"
        sideOffset={6}
        aria-label={managing ? 'Pinned filters' : 'Tag filters'}
        className={cn(
          'max-h-(--available-height) max-w-[calc(100vw-1.5rem)] overflow-y-auto',
          management !== undefined ? 'w-80' : 'w-56 p-0',
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
            <Command label="Filter by another tag">
              <CommandInput
                ref={inputRef}
                value={query}
                onValueChange={setQuery}
                placeholder="Filter by any tag…"
              />
              <CommandList>
                {/* A force-mounted item never counts as a match, so cmdk would
                show the empty state right above it — render one or the other. */}
                {offerTyped ? null : <CommandEmpty>{emptyMessage}</CommandEmpty>}
                {facets.length > 0 ? (
                  <CommandGroup>
                    {facets.map((facet) => (
                      <CommandItem
                        key={foldTag(facet.tag)}
                        value={facet.tag}
                        keywords={[`#${facet.tag}`]}
                        data-checked={
                          activeTag !== null && foldTag(activeTag) === foldTag(facet.tag)
                        }
                        onSelect={() => choose(facet.tag)}
                      >
                        <span className="min-w-0 flex-1 truncate">#{facet.tag}</span>
                        <span className="shrink-0 text-xs tabular-nums text-text-muted">
                          {pinnedKeys.has(foldTag(facet.tag)) ? 'Pinned · ' : ''}
                          {facet.count}
                        </span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                ) : null}
                {offerTyped ? (
                  // The group needs forceMount too: cmdk hides a group whenever
                  // no item inside it matches the query, even force-mounted ones.
                  <CommandGroup forceMount>
                    <CommandItem
                      forceMount
                      value={`custom:${typed}`}
                      onSelect={() => choose(typed)}
                    >
                      <span className="min-w-0 flex-1 truncate">Filter by #{typed}</span>
                    </CommandItem>
                  </CommandGroup>
                ) : null}
              </CommandList>
            </Command>
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
      </PopoverContent>
    </Popover>
  )
}
