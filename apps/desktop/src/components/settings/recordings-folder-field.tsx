import type { ReactElement } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { FolderOpen } from 'lucide-react'
import { RECORDING_TRANSCRIPTS_DIR } from '@reflect/core'
import { Button } from '@/components/ui/button.tsx'
import { SettingsField } from './field.tsx'

interface RecordingsFolderFieldProps {
  /** The chosen folder, or empty for the default. */
  folder: string
  /** The app's own folder, used while none is chosen. */
  defaultFolder: string
  /** Persist a chosen folder, or empty to return to the default. */
  onChange: (folder: string) => void
}

/** Where archived recordings go: a chosen folder, or the app's default. */
export function RecordingsFolderField({
  folder,
  defaultFolder,
  onChange,
}: RecordingsFolderFieldProps): ReactElement {
  async function choose(): Promise<void> {
    const result = await open({
      multiple: false,
      directory: true,
      title: 'Choose where recordings are kept',
      defaultPath: folder || defaultFolder,
    })
    if (typeof result === 'string') {
      onChange(result)
    }
  }

  return (
    <SettingsField
      legend="Recordings folder"
      description={`Audio is kept here once it is transcribed. Transcripts go to ${RECORDING_TRANSCRIPTS_DIR}/ in this graph and are linked from the day's note.`}
    >
      <p
        className="mt-2 truncate font-mono text-xs text-text-muted"
        title={folder || defaultFolder}
      >
        {folder || defaultFolder}
      </p>
      <div className="mt-2 flex gap-2">
        <Button type="button" size="xs" variant="outline" onClick={() => void choose()}>
          <FolderOpen aria-hidden strokeWidth={1.75} />
          Choose...
        </Button>
        {folder === '' ? null : (
          <Button type="button" size="xs" variant="ghost" onClick={() => onChange('')}>
            Use default
          </Button>
        )}
      </div>
    </SettingsField>
  )
}
