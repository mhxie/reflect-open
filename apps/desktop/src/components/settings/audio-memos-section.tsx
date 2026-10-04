import type { ReactElement } from 'react'
import { TRANSCRIPTION_PROMPT_MAX_LENGTH, normalizeTranscriptionPrompt } from '@reflect/core'
import { isMacosDesktop } from '@/lib/platform.ts'
import { useSettings } from '@/providers/settings-provider.tsx'
import { LocalModelField } from './local-model-field.tsx'
import { SettingsSection } from './section.tsx'
import { SettingsSwitchField } from './switch-field.tsx'
import { SettingsTextareaField } from './textarea-field.tsx'
import { TranscriptionEngineField } from './transcription-engine-field.tsx'
import { TranscriptionLanguageField } from './transcription-language-field.tsx'

/**
 * Preferences for recording enrichment after the raw audio is safely stored.
 * The engine choice exists on macOS only, where whisper.cpp runs on Metal.
 */
export function AudioMemosSection(): ReactElement {
  const { settings, updateSettings } = useSettings()

  return (
    <SettingsSection id="audio-memos">
      {isMacosDesktop ? <TranscriptionEngineField /> : null}
      {isMacosDesktop && settings.transcriptionEngine === 'local' ? <LocalModelField /> : null}
      <TranscriptionLanguageField />
      {settings.transcriptionEngine === 'cloud' ? (
        <SettingsSwitchField
          legend="Transcription auto-format"
          description="Use AI to add punctuation, paragraphs, and light Markdown while preserving the original meaning."
          checked={settings.transcriptionFormat}
          onCheckedChange={(transcriptionFormat) => updateSettings({ transcriptionFormat })}
        />
      ) : null}
      <SettingsTextareaField
        legend="Transcription helper text"
        description="Context given to the transcription engine with every audio memo, such as names it tends to misspell."
        ariaLabel="Transcription helper text"
        value={settings.transcriptionPrompt}
        placeholder="This transcription mentions the following names:"
        maxLength={TRANSCRIPTION_PROMPT_MAX_LENGTH}
        rows={2}
        normalize={normalizeTranscriptionPrompt}
        onSave={(transcriptionPrompt) => updateSettings({ transcriptionPrompt })}
      />
    </SettingsSection>
  )
}
