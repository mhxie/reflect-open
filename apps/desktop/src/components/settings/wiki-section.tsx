import { useState, type ReactElement } from 'react'
import { normalizeWikiFolder, normalizeWikiLanguages } from '@reflect/core'
import { X } from 'lucide-react'
import { useSettings } from '@/providers/settings-provider.tsx'
import { SettingsField } from './field.tsx'
import { SettingsSection } from './section.tsx'
import { WikiTrustDisplayField } from './wiki-trust-display-field.tsx'
import { WikiTrustReportField } from './wiki-trust-report-field.tsx'

const INPUT_CLASS =
  'w-full rounded-[7px] border border-border-strong bg-input-bg px-2.5 py-1.5 text-sm text-text shadow-input placeholder:text-text-muted'

/**
 * The wiki's languages (the source first, whose folder holds the entries,
 * then each translation and the folder holding its copies at the same paths),
 * and how the agent harness's claim verdicts show. The Wiki screen's language
 * tabs and "Missing" filters, and the note sidebar's language switch, all
 * read the language list.
 */
export function WikiSection(): ReactElement {
  const { settings, updateSettingsWith } = useSettings()
  const languages = settings.wikiLanguages
  const [label, setLabel] = useState('')
  const [folder, setFolder] = useState('')
  const [error, setError] = useState<string | null>(null)

  const addLanguage = (): void => {
    const name = label.trim()
    const normalized = normalizeWikiFolder(folder)
    if (name === '') {
      setError('Give the language a name, such as 日本語.')
      return
    }
    if (normalized === null) {
      setError(`"${folder.trim()}" can't be a folder — use a graph folder such as wiki-ja.`)
      return
    }
    const next = normalizeWikiLanguages([...languages, { label: name, folder: normalized }])
    if (next.length === languages.length) {
      setError(`${normalized}/ is already a wiki folder, or inside one.`)
      return
    }
    // Applied to the loaded settings, not this render's: an edit made while
    // they still load must not replace the saved list with the defaults.
    updateSettingsWith((current) => ({
      wikiLanguages: normalizeWikiLanguages([
        ...current.wikiLanguages,
        { label: name, folder: normalized },
      ]),
    }))
    setLabel('')
    setFolder('')
    setError(null)
  }

  const removeLanguage = (removed: string): void => {
    // The first language is the source and stays, whatever was on screen.
    updateSettingsWith((current) => ({
      wikiLanguages: current.wikiLanguages.filter(
        (language, index) => index === 0 || language.folder !== removed,
      ),
    }))
  }

  return (
    <SettingsSection id="wiki">
      <SettingsField
        legend="Languages"
        description="The first folder holds the wiki's entries; each other folder holds their translations at the same paths."
      >
        <ul className="mt-3 space-y-1.5">
          {languages.map((language, index) => (
            <li key={language.folder} className="flex items-center gap-2 text-[13px]">
              <span className="font-medium text-text">{language.label}</span>
              <span className="text-text-secondary">{language.folder}/</span>
              {index === 0 ? (
                <span className="rounded border border-border px-1 text-[10px] leading-4 text-text-muted">
                  Source
                </span>
              ) : (
                <button
                  type="button"
                  aria-label={`Remove ${language.label}`}
                  onClick={() => removeLanguage(language.folder)}
                  className="rounded-full p-0.5 text-text-muted transition-colors duration-100 hover:bg-border hover:text-text"
                >
                  <X aria-hidden strokeWidth={2} className="size-3" />
                </button>
              )}
            </li>
          ))}
        </ul>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            addLanguage()
          }}
          className="mt-3 flex max-w-md gap-2"
        >
          <input
            type="text"
            value={label}
            onChange={(event) => {
              setLabel(event.target.value)
              setError(null)
            }}
            aria-label="Language name"
            placeholder="Name (日本語)"
            className={INPUT_CLASS}
          />
          <input
            type="text"
            value={folder}
            onChange={(event) => {
              setFolder(event.target.value)
              setError(null)
            }}
            aria-label="Language folder"
            aria-invalid={error !== null}
            placeholder="Folder (wiki-ja)"
            className={INPUT_CLASS}
          />
          <button
            type="submit"
            aria-label="Add language"
            className="rounded-[7px] border border-border-strong bg-surface px-3 py-1.5 text-sm font-medium text-text-secondary shadow-input transition-colors duration-100 hover:bg-surface-hover hover:text-text"
          >
            Add
          </button>
        </form>
        {error !== null ? (
          <p role="alert" className="mt-2 text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </SettingsField>
      <WikiTrustDisplayField />
      <WikiTrustReportField />
    </SettingsSection>
  )
}
