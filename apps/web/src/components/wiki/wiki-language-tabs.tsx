import type { ReactElement } from 'react'
import { wikiSourceLanguage, type WikiLanguage } from '@reflect/core'
import { FilterTab } from '@/components/all-notes/filter-tab.tsx'

interface WikiLanguageTabsProps {
  /** The wiki's languages, source first. */
  languages: readonly WikiLanguage[]
  /** The folder of the language the wiki is read in, or null for the source. */
  language: string | null
  onSelect: (language: string | null) => void
}

/**
 * The language the Wiki screen is read in: the source, or one of its
 * translations, where each entry lists, sorts, and opens as its copy in that
 * language — or as its source while it has none.
 */
export function WikiLanguageTabs({
  languages,
  language,
  onSelect,
}: WikiLanguageTabsProps): ReactElement {
  const source = wikiSourceLanguage(languages)
  return (
    <div
      role="group"
      aria-label="Language"
      className="flex items-stretch divide-x divide-border overflow-hidden rounded-lg border border-border bg-surface shadow-sm"
    >
      <FilterTab label={source.label} active={language === null} onClick={() => onSelect(null)} />
      {languages.slice(1).map((item) => (
        <FilterTab
          key={item.folder}
          label={item.label}
          active={language === item.folder}
          onClick={() => onSelect(item.folder)}
        />
      ))}
    </div>
  )
}
