import type { ReactElement } from 'react'
import { FilterTab } from '@/components/all-notes/filter-tab.tsx'

interface WikiLayoutTabsProps {
  /** Grouped by topic folder (true) or one flat list. */
  grouped: boolean
  onChange: (grouped: boolean) => void
}

/** The Wiki screen's layout switch: one flat list, or sections per topic. */
export function WikiLayoutTabs({ grouped, onChange }: WikiLayoutTabsProps): ReactElement {
  return (
    <div
      role="group"
      aria-label="Layout"
      className="flex items-stretch divide-x divide-border overflow-hidden rounded-lg border border-border bg-surface shadow-sm"
    >
      <FilterTab label="Flat" active={!grouped} onClick={() => onChange(false)} />
      <FilterTab label="Topics" active={grouped} onClick={() => onChange(true)} />
    </div>
  )
}
