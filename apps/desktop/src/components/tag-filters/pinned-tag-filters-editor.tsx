import { useCallback, useLayoutEffect, useRef, useState, type ReactElement } from 'react'
import {
  foldTag,
  movePinnedFilterTag,
  normalizePinnedTag,
  pinnedTagOrdersEqual,
  type NoteTagFacet,
  type PinnedTagMove,
} from '@reflect/core'
import { Pin } from 'lucide-react'
import { Button } from '@/components/ui/button.tsx'
import { Input } from '@/components/ui/input.tsx'
import { usePinnedTagFilters } from '@/hooks/use-pinned-tag-filters.ts'
import type { PinnedTagControl } from './pinned-tag-filter-row.tsx'
import { PinnedTagSortableList } from './pinned-tag-sortable-list.tsx'

interface PinnedTagFiltersEditorProps {
  readonly facets?: readonly NoteTagFacet[]
}

interface TagFocusTarget {
  readonly tag: string
  readonly control: PinnedTagControl
}

/** Manage the shared All Notes pin list without changing the active tag filter. */
export function PinnedTagFiltersEditor({ facets }: PinnedTagFiltersEditorProps): ReactElement {
  const { tags, pinTag, unpinTag, moveTag, reorderTags } = usePinnedTagFilters()
  const [query, setQuery] = useState('')
  const [announcement, setAnnouncement] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const controls = useRef(new Map<string, HTMLButtonElement>())
  const pendingFocus = useRef<TagFocusTarget | 'input' | null>(null)
  const finalFocusTarget = useRef<TagFocusTarget | 'input' | null>(null)
  const typed = normalizePinnedTag(query)
  const alreadyPinned = typed !== null && tags.includes(typed)
  const invalid = query.trim() !== '' && typed === null
  const search = foldTag(query.trim().replace(/^#+/, '').trim())
  const suggestions = (facets ?? []).filter((facet) => {
    const tag = normalizePinnedTag(facet.tag)
    return tag !== null && !tags.includes(tag) && tag.includes(search) && tag !== typed
  })

  const findFocusTarget = useCallback(
    (target: TagFocusTarget | 'input' | null): HTMLElement | null =>
      target === null || target === 'input'
        ? inputRef.current
        : (controls.current.get(`${target.control}:${target.tag}`) ?? inputRef.current),
    [],
  )
  const registerControl = useCallback(
    (tag: string, control: PinnedTagControl, element: HTMLButtonElement | null): void => {
      const key = `${control}:${tag}`
      if (element === null) {
        controls.current.delete(key)
      } else {
        controls.current.set(key, element)
      }
    },
    [],
  )

  useLayoutEffect(() => {
    if (pendingFocus.current !== null) {
      findFocusTarget(pendingFocus.current)?.focus({ preventScroll: true })
      pendingFocus.current = null
    }
  }, [tags, findFocusTarget])

  // Focus moves once the edited list renders. An edit that changes nothing
  // yet (queued before settings load, or already applied elsewhere) renders
  // no new list, so its request is dropped instead of firing on a later one.
  const editWithFocus = (target: TagFocusTarget | 'input', edit: () => boolean): void => {
    pendingFocus.current = target
    finalFocusTarget.current = target
    if (!edit() && pendingFocus.current === target) {
      pendingFocus.current = null
    }
  }

  const add = (input: string): void => {
    const tag = normalizePinnedTag(input)
    if (tag === null || tags.includes(tag)) {
      return
    }
    editWithFocus('input', () => pinTag(tag))
    setQuery('')
    setAnnouncement(`Pinned #${tag}.`)
  }

  const move = (tag: string, direction: PinnedTagMove): void => {
    const next = movePinnedFilterTag(tags, tag, direction)
    if (pinnedTagOrdersEqual(tags, next)) {
      return
    }
    editWithFocus({ tag, control: 'menu' }, () => moveTag(tag, direction))
    setAnnouncement(`#${tag} moved to position ${next.indexOf(tag) + 1} of ${next.length}.`)
  }

  const unpin = (tag: string): void => {
    const index = tags.indexOf(tag)
    const nextTag = tags[index + 1] ?? tags[index - 1]
    editWithFocus(nextTag === undefined ? 'input' : { tag: nextTag, control: 'menu' }, () =>
      unpinTag(tag),
    )
    setAnnouncement(`Unpinned #${tag}.`)
  }

  return (
    <div className="min-w-0">
      <p className="text-xs text-text-muted">Shared across your graphs. Drag to reorder.</p>
      {tags.length === 0 ? (
        <p className="py-3 text-[13px] text-text-muted">No pinned tags. Add a tag below.</p>
      ) : (
        <PinnedTagSortableList
          tags={tags}
          onReorder={(original, next, tag) => {
            if (!pinnedTagOrdersEqual(original, next)) {
              editWithFocus({ tag, control: 'handle' }, () => reorderTags(original, next))
            }
          }}
          onMove={move}
          onUnpin={unpin}
          registerControl={registerControl}
          menuFinalFocus={(tag) =>
            controls.current.get(`menu:${tag}`) ?? findFocusTarget(finalFocusTarget.current)
          }
        />
      )}
      <form
        className="mt-2 flex min-w-0 gap-1.5"
        onSubmit={(event) => {
          event.preventDefault()
          add(query)
        }}
      >
        <Input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Add filter tag"
          aria-invalid={invalid}
          placeholder="Find a tag to pin…"
        />
        <Button
          type="submit"
          variant="outline"
          size="sm"
          disabled={typed === null || alreadyPinned}
          aria-label={typed === null ? 'Pin tag' : `Pin #${typed}`}
        >
          <Pin aria-hidden className="size-3.5" strokeWidth={1.75} />
          Pin
        </Button>
      </form>
      {invalid ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          "{search}" can't be a tag — tags start with a letter and use letters, numbers, /, _ or -.
        </p>
      ) : alreadyPinned ? (
        <p className="mt-2 text-xs text-text-muted">#{typed} is already pinned.</p>
      ) : null}
      {suggestions.length === 0 ? null : (
        <ul aria-label="Tags to pin" className="mt-2 max-h-40 overflow-y-auto overscroll-contain">
          {suggestions.map((facet) => (
            <li key={foldTag(facet.tag)}>
              <Button
                type="button"
                variant="ghost"
                className="h-auto min-h-8 w-full justify-start gap-1.5 px-2 py-1.5 text-[13px] font-normal"
                aria-label={`Pin #${facet.tag}`}
                onClick={() => add(facet.tag)}
              >
                <Pin aria-hidden className="size-3.5 shrink-0 text-text-muted" strokeWidth={1.75} />
                <span className="min-w-0 flex-1 truncate text-left">#{facet.tag}</span>
                <span className="shrink-0 text-xs tabular-nums text-text-muted">{facet.count}</span>
              </Button>
            </li>
          ))}
        </ul>
      )}
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
    </div>
  )
}
