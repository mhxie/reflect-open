import type { ReactElement } from 'react'
import type { NoteAttachmentType } from '@reflect/core'
import { ATTACHMENT_FILTER_LABELS } from '@/components/all-notes/attachment-filter-labels.ts'
import { FilterTab } from '@/components/all-notes/filter-tab.tsx'

interface AttachmentTypeTabsProps {
  /** The active type (`null` = the All tab). */
  type: NoteAttachmentType | null
  /** The types offered as tabs, in display order. */
  types: readonly NoteAttachmentType[]
  onSelect: (type: NoteAttachmentType | null) => void
}

/** The Attachments filter bar: an All tab and one tab per attachment type. */
export function AttachmentTypeTabs({
  type,
  types,
  onSelect,
}: AttachmentTypeTabsProps): ReactElement {
  return (
    <div
      role="group"
      aria-label="Filter attachments"
      className="flex items-stretch divide-x divide-border overflow-hidden rounded-lg border border-border bg-surface shadow-sm"
    >
      <FilterTab label="All" active={type === null} onClick={() => onSelect(null)} />
      {types.map((candidate) => (
        <FilterTab
          key={candidate}
          label={ATTACHMENT_FILTER_LABELS[candidate]}
          active={type === candidate}
          onClick={() => onSelect(candidate)}
        />
      ))}
    </div>
  )
}
