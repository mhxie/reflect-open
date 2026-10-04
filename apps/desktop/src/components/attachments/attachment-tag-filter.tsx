import type { ReactElement } from 'react'
import { X } from 'lucide-react'
import type { NoteTagFacet } from '@reflect/core'
import { CustomFilterMenu } from '@/components/all-notes/custom-filter-menu.tsx'

interface AttachmentTagFilterProps {
  /** The active tag, or null. */
  tag: string | null
  /** Tags on the notes linking to the files in view, with file counts. */
  facets: NoteTagFacet[]
  onSelect: (tag: string | null) => void
}

/**
 * The Attachments tag filter: the All Notes tag combobox (listed tags plus
 * free entry of any tag name), with a clear button while a tag is active.
 */
export function AttachmentTagFilter({
  tag,
  facets,
  onSelect,
}: AttachmentTagFilterProps): ReactElement {
  return (
    <div
      role="group"
      aria-label="Filter attachments by tag"
      className="flex items-stretch divide-x divide-border overflow-hidden rounded-lg border border-border bg-surface shadow-sm"
    >
      <CustomFilterMenu facets={facets} activeTag={tag} onSelect={onSelect} label="Tag" />
      {tag === null ? null : (
        <button
          type="button"
          aria-label="Clear tag filter"
          onClick={() => onSelect(null)}
          className="flex items-center px-2 text-text-secondary transition-colors duration-100 hover:bg-surface-hover hover:text-text"
        >
          <X aria-hidden strokeWidth={1.75} className="size-3.5" />
        </button>
      )}
    </div>
  )
}
