import { useEffect, useRef, type ReactElement } from 'react'
import { foldTag, NOTE_ATTACHMENT_TYPES, type NoteTagFacet } from '@reflect/core'
import { formatShortDate } from '@/lib/dates.ts'
import { useSettings } from '@/providers/settings-provider.tsx'
import { usePinnedTagFilters } from '@/hooks/use-pinned-tag-filters.ts'
import { PinnedTagFiltersEditor } from '@/components/tag-filters/pinned-tag-filters-editor.tsx'
import type { AllNotesFilter } from '@/routing/route.ts'
import { ATTACHMENT_FILTER_LABELS } from './attachment-filter-labels.ts'
import { CustomFilterMenu } from './custom-filter-menu.tsx'
import { FilterTab } from './filter-tab.tsx'

interface AllNotesFiltersProps {
  /** The active filter (`null` = the All tab). */
  filter: AllNotesFilter | null
  /** Every tag carried by a non-daily note, for the Custom menu. */
  facets: NoteTagFacet[]
  onSelect: (filter: AllNotesFilter | null) => void
}

/**
 * The All Notes filter bar: an All tab, the edit day when one is set,
 * one tab per pinned tag (the `allNotesFilterTags` setting), one per enabled
 * attachment type (the `allNotesFilterAttachments` setting), and a Custom
 * combobox offering every tag, free entry, and pinned-filter management. One
 * filter at a time. Tag matching is case-insensitive throughout, same as the
 * `#tag` search token.
 */
export function AllNotesFilters({ filter, facets, onSelect }: AllNotesFiltersProps): ReactElement {
  const { settings } = useSettings()
  const { tags: pinned, pinTag } = usePinnedTagFilters()
  const stripRef = useRef<HTMLDivElement>(null)
  const tag = filter?.kind === 'tag' ? filter.tag : null
  const activeType = filter?.kind === 'attachment' ? filter.type : null
  // A type switched off in settings keeps its tab while it is the active filter.
  const types = NOTE_ATTACHMENT_TYPES.filter(
    (type) => settings.allNotesFilterAttachments.includes(type) || type === activeType,
  )

  const pinnedKeys = new Set(pinned)

  const activeKey = tag === null ? null : foldTag(tag)
  const customTag = tag !== null && !pinnedKeys.has(foldTag(tag)) ? tag : null
  const facetKeys = new Set(facets.map((facet) => foldTag(facet.tag)))
  const customFacets = [
    ...facets,
    ...pinned.filter((entry) => !facetKeys.has(entry)).map((entry) => ({ tag: entry, count: 0 })),
  ]

  useEffect(() => {
    stripRef.current?.querySelector('[aria-pressed="true"]')?.scrollIntoView({
      block: 'nearest',
      inline: 'nearest',
    })
  }, [filter, pinned])

  return (
    <div
      role="group"
      aria-label="Filter notes"
      className="flex min-w-0 max-w-full items-stretch overflow-hidden rounded-lg border border-border bg-surface shadow-sm"
    >
      <FilterTab label="All" active={filter === null} onClick={() => onSelect(null)} />
      <div
        ref={stripRef}
        className="scrollbar-none flex min-w-0 flex-1 items-stretch divide-x divide-border overflow-x-auto border-x border-border"
      >
        {filter?.kind === 'updated' ? (
          <FilterTab
            label={`Edited ${formatShortDate(filter.date, settings.dateFormat)}`}
            active
            onClick={() => onSelect(filter)}
          />
        ) : null}
        {pinned.map((pinnedTag) => (
          <FilterTab
            key={foldTag(pinnedTag)}
            label={`#${pinnedTag}`}
            truncateLabel
            active={activeKey === foldTag(pinnedTag)}
            onClick={() => onSelect({ kind: 'tag', tag: pinnedTag })}
          />
        ))}
        {types.map((type) => (
          <FilterTab
            key={type}
            label={ATTACHMENT_FILTER_LABELS[type]}
            active={activeType === type}
            onClick={() => onSelect({ kind: 'attachment', type })}
          />
        ))}
      </div>
      <CustomFilterMenu
        facets={customFacets}
        activeTag={customTag}
        onSelect={(next) => onSelect({ kind: 'tag', tag: next })}
        pinnedTags={pinned}
        management={<PinnedTagFiltersEditor facets={facets} />}
        onPinCurrent={customTag === null ? undefined : () => pinTag(customTag)}
      />
    </div>
  )
}
