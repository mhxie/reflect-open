import type { ReactElement } from 'react'
import { foldTag, NOTE_ATTACHMENT_TYPES, type NoteTagFacet } from '@reflect/core'
import { useSettings } from '@/providers/settings-provider.tsx'
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
 * The All Notes filter bar: an All tab, one tab per pinned tag (the
 * `allNotesFilterTags` setting), one per enabled attachment type (the
 * `allNotesFilterAttachments` setting), and a Custom combobox offering every
 * remaining tag plus free entry of any tag name. One filter at a time. Tag
 * matching is case-insensitive throughout, same as the `#tag` search token.
 */
export function AllNotesFilters({ filter, facets, onSelect }: AllNotesFiltersProps): ReactElement {
  const { settings } = useSettings()
  const tag = filter?.kind === 'tag' ? filter.tag : null
  const activeType = filter?.kind === 'attachment' ? filter.type : null
  // A type switched off in settings keeps its tab while it is the active filter.
  const types = NOTE_ATTACHMENT_TYPES.filter(
    (type) => settings.allNotesFilterAttachments.includes(type) || type === activeType,
  )

  // The setting is user-edited JSON — dedupe case-insensitively and drop
  // blanks so a hand-edited document can't render twin or empty tabs.
  const pinned: string[] = []
  const pinnedKeys = new Set<string>()
  for (const entry of settings.allNotesFilterTags) {
    const trimmed = entry.trim()
    const key = foldTag(trimmed)
    if (key !== '' && !pinnedKeys.has(key)) {
      pinnedKeys.add(key)
      pinned.push(trimmed)
    }
  }

  const activeKey = tag === null ? null : foldTag(tag)
  const customTag = tag !== null && !pinnedKeys.has(foldTag(tag)) ? tag : null
  const customFacets = facets.filter((facet) => !pinnedKeys.has(foldTag(facet.tag)))

  return (
    <div
      role="group"
      aria-label="Filter notes"
      className="flex items-stretch divide-x divide-border overflow-hidden rounded-lg border border-border bg-surface shadow-sm"
    >
      <FilterTab label="All" active={filter === null} onClick={() => onSelect(null)} />
      {pinned.map((pinnedTag) => (
        <FilterTab
          key={foldTag(pinnedTag)}
          label={`#${pinnedTag}`}
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
      <CustomFilterMenu
        facets={customFacets}
        activeTag={customTag}
        onSelect={(next) => onSelect({ kind: 'tag', tag: next })}
      />
    </div>
  )
}
