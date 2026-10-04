import type { ReactElement } from 'react'
import { useRecorder } from '@/providers/recorder-provider.tsx'
import { useSettings } from '@/providers/settings-provider.tsx'
import { SettingsField } from './field.tsx'
import { LocalModelField } from './local-model-field.tsx'
import { RecordingsFolderField } from './recordings-folder-field.tsx'
import { RecordingShortcutField } from './recording-shortcut-field.tsx'
import { SettingsSection } from './section.tsx'
import { SettingsSwitchField } from './switch-field.tsx'

/**
 * Recording on the Mac (macOS 14.2+): every recording, a memo or a call,
 * captures the microphone and system audio as two channels and is
 * transcribed on this Mac, so a call needs no speaker detection. Controls for
 * reaching it from another app, and where the audio is archived;
 * transcription uses the on-device model from Audio memos.
 */
export function RecordingSection(): ReactElement {
  const { settings, updateSettings } = useSettings()
  const { supported, defaultRecordingsFolder } = useRecorder()

  if (!supported) {
    return (
      <SettingsSection id="recording">
        <SettingsField
          legend="System audio"
          description="Recording what the Mac plays alongside the microphone needs macOS 14.2 or later."
        >
          {null}
        </SettingsField>
      </SettingsSection>
    )
  }

  return (
    <SettingsSection id="recording">
      <SettingsSwitchField
        legend="Show in menu bar"
        description="Start and stop recording from the menu bar, for example while you're in a call."
        checked={settings.recordingMenuBar}
        onCheckedChange={(recordingMenuBar) => updateSettings({ recordingMenuBar })}
      />
      <RecordingShortcutField
        key={settings.recordingShortcut}
        value={settings.recordingShortcut}
        onSave={(recordingShortcut) => updateSettings({ recordingShortcut })}
      />
      <RecordingsFolderField
        folder={settings.recordingsFolder}
        defaultFolder={defaultRecordingsFolder}
        onChange={(recordingsFolder) => updateSettings({ recordingsFolder })}
      />
      {settings.transcriptionEngine === 'local' ? null : <LocalModelField />}
    </SettingsSection>
  )
}
