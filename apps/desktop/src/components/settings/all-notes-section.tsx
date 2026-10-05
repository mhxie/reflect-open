import type { ReactElement } from 'react'
import { PinnedTagFiltersEditor } from '@/components/tag-filters/pinned-tag-filters-editor.tsx'
import { AiSummariesField } from './ai-summaries-field.tsx'
import { AllNotesAttachmentFiltersField } from './all-notes-attachment-filters-field.tsx'
import { SettingsField } from './field.tsx'
import { SettingsSection } from './section.tsx'

/** Configure the shared All Notes tag order, attachment filters, and AI summaries. */
export function AllNotesSection(): ReactElement {
  return (
    <SettingsSection id="all-notes">
      <SettingsField
        legend="Filter tags"
        description="Tags pinned as one-click filters at the top of the All Notes screen."
      >
        <div className="mt-3 max-w-md">
          <PinnedTagFiltersEditor />
        </div>
      </SettingsField>
      <AllNotesAttachmentFiltersField />
      <AiSummariesField />
    </SettingsSection>
  )
}
