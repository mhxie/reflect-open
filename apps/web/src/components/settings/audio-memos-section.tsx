import type { ReactElement } from 'react'
import { TRANSCRIPTION_PROMPT_MAX_LENGTH, normalizeTranscriptionPrompt } from '@reflect/core'
import {
  useSettingsService,
  useSettingsStore,
  useTranscriptionFormat,
  useTranscriptionPrompt,
} from '@/providers/settings-provider.tsx'
import { useCoreServices } from '@/services/services-provider.tsx'
import { LocalModelField } from './local-model-field.tsx'
import { SettingsSection } from './section.tsx'
import { SettingsSwitchField } from './switch-field.tsx'
import { SettingsTextareaField } from './textarea-field.tsx'
import { TranscriptionEngineField } from './transcription-engine-field.tsx'
import { TranscriptionLanguagesField } from './transcription-languages-field.tsx'

/**
 * Preferences for recording enrichment after the raw audio is safely stored.
 * The engine choice exists on macOS only, where whisper.cpp runs on Metal.
 */
export function AudioMemosSection(): ReactElement {
  const transcriptionFormat = useTranscriptionFormat()
  const transcriptionPrompt = useTranscriptionPrompt()
  const settingsService = useSettingsService()
  const { transcriptionEngine } = useSettingsStore()
  const { platform } = useCoreServices()

  return (
    <SettingsSection id="audio-memos">
      {platform.isMacosDesktop ? <TranscriptionEngineField /> : null}
      {platform.isMacosDesktop && transcriptionEngine === 'local' ? <LocalModelField /> : null}
      <TranscriptionLanguagesField />
      {transcriptionEngine === 'cloud' ? (
        <SettingsSwitchField
          legend="Transcription auto-format"
          description="Use AI to add punctuation, paragraphs, and light Markdown while preserving the original meaning."
          checked={transcriptionFormat}
          onCheckedChange={(transcriptionFormat) => settingsService.update({ transcriptionFormat })}
        />
      ) : null}
      <SettingsTextareaField
        legend="Transcription helper text"
        description="Context given to the transcription engine with every audio memo, such as names it tends to misspell."
        ariaLabel="Transcription helper text"
        value={transcriptionPrompt}
        placeholder="This transcription mentions the following names:"
        maxLength={TRANSCRIPTION_PROMPT_MAX_LENGTH}
        rows={2}
        normalize={normalizeTranscriptionPrompt}
        onSave={(transcriptionPrompt) => settingsService.update({ transcriptionPrompt })}
      />
    </SettingsSection>
  )
}
