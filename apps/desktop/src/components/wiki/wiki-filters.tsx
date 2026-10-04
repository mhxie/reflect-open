import { useMemo, type ReactElement } from 'react'
import {
  filterWikiEntries,
  wikiEntryTags,
  wikiFiltersEqual,
  type WikiEntry,
  type WikiFilter,
  type WikiLanguage,
} from '@reflect/core'
import { CustomFilterMenu } from '@/components/all-notes/custom-filter-menu.tsx'
import { FilterTab } from '@/components/all-notes/filter-tab.tsx'

interface WikiFiltersProps {
  /** Every wiki entry; each tab counts the ones it would keep. */
  entries: readonly WikiEntry[]
  /** The wiki's languages, source first; each translation gets a "Missing" tab. */
  languages: readonly WikiLanguage[]
  /** The active filter (`null` = the All tab). */
  filter: WikiFilter | null
  onSelect: (filter: WikiFilter | null) => void
}

/**
 * The Wiki screen's filter bar: All, then the states the claims schema makes
 * legible — a flagged claim, no reviewer verification yet, a claim without a
 * source, no copy in a translation — each with its count, and a Tag menu once
 * any entry carries a tag. One filter at a time, like All Notes.
 */
export function WikiFilters({
  entries,
  languages,
  filter,
  onSelect,
}: WikiFiltersProps): ReactElement {
  const tabs = useMemo(() => {
    const candidates: { label: string; filter: WikiFilter }[] = [
      { label: 'Flagged', filter: { kind: 'flagged' } },
      { label: 'Unreviewed', filter: { kind: 'unreviewed' } },
      { label: 'Unsourced', filter: { kind: 'unsourced' } },
      ...languages.slice(1).map((language) => ({
        label: `Missing ${language.label}`,
        filter: { kind: 'untranslated', folder: language.folder } satisfies WikiFilter,
      })),
    ]
    return candidates.map((tab) => ({
      ...tab,
      count: filterWikiEntries(entries, tab.filter).length,
    }))
  }, [entries, languages])
  const facets = useMemo(() => {
    const tags = wikiEntryTags(entries)
    return tags.map((tag) => ({
      tag,
      count: filterWikiEntries(entries, { kind: 'tag', tag }).length,
    }))
  }, [entries])
  const activeTag = filter?.kind === 'tag' ? filter.tag : null

  return (
    <div
      role="group"
      aria-label="Filter entries"
      className="flex items-stretch divide-x divide-border overflow-hidden rounded-lg border border-border bg-surface shadow-sm"
    >
      <FilterTab label="All" active={filter === null} onClick={() => onSelect(null)} />
      {tabs.map((tab) => (
        <FilterTab
          key={
            tab.filter.kind === 'untranslated'
              ? `untranslated:${tab.filter.folder}`
              : tab.filter.kind
          }
          label={`${tab.label} ${tab.count}`}
          active={wikiFiltersEqual(filter, tab.filter)}
          onClick={() => onSelect(tab.filter)}
        />
      ))}
      {facets.length > 0 || activeTag !== null ? (
        <CustomFilterMenu
          label="Tag"
          facets={facets}
          activeTag={activeTag}
          onSelect={(tag) => onSelect({ kind: 'tag', tag })}
        />
      ) : null}
    </div>
  )
}
