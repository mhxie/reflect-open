import type { ReactElement } from 'react'
import { NOTE_ATTACHMENT_TYPES, type NoteAttachmentType } from '@reflect/core'
import {
  ATTACHMENT_FILTER_LABELS,
  ATTACHMENT_FILTER_NOUNS,
} from '@/components/all-notes/attachment-filter-labels.ts'
import { Switch } from '@/components/ui/switch.tsx'
import { useSettings } from '@/providers/settings-provider.tsx'
import { SettingsField } from './field.tsx'

/**
 * Which attachment types the All Notes screen offers as one-click filter tabs
 * (the `allNotesFilterAttachments` setting). Turning one off hides its tab,
 * never the notes.
 */
export function AllNotesAttachmentFiltersField(): ReactElement {
  const { settings, updateSettings } = useSettings()
  const enabled = settings.allNotesFilterAttachments

  const setEnabled = (type: NoteAttachmentType, checked: boolean): void => {
    updateSettings({
      allNotesFilterAttachments: NOTE_ATTACHMENT_TYPES.filter((candidate) =>
        candidate === type ? checked : enabled.includes(candidate),
      ),
    })
  }

  return (
    <SettingsField
      legend="Filter types"
      description="Attachment types offered as one-click filters, after the pinned tags. Video includes YouTube links."
    >
      <ul className="mt-3 flex flex-col gap-2.5">
        {NOTE_ATTACHMENT_TYPES.map((type) => (
          <li key={type} className="flex items-center gap-3">
            <Switch
              aria-label={`Show the ${ATTACHMENT_FILTER_LABELS[type]} filter`}
              checked={enabled.includes(type)}
              onCheckedChange={(checked) => setEnabled(type, checked)}
            />
            <span className="text-[13px] text-text-secondary">
              {ATTACHMENT_FILTER_LABELS[type]}
              <span className="text-text-muted"> — notes with {ATTACHMENT_FILTER_NOUNS[type]}</span>
            </span>
          </li>
        ))}
      </ul>
    </SettingsField>
  )
}
