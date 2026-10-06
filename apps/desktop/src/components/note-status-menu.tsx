import { useEffect, useState, type KeyboardEvent, type ReactElement } from 'react'
import { errorMessage, type NoteState } from '@reflect/core'
import {
  CloudAlert,
  CloudCheck,
  CloudOff,
  CloudUpload,
  FileText,
  FileWarning,
  GitCommitHorizontal,
  HardDrive,
  LockKeyhole,
  Shield,
} from 'lucide-react'
import type { NoteDetail, NoteDetailSections } from '@/lib/note-details.ts'
import { startOperation } from '@/lib/operations.ts'
import { NotePrivacyAction } from './note-privacy-action.tsx'
import { NOTE_MENU_ITEM, NoteMenuRow, NoteMenuSection } from './note-menu-row.tsx'

/** How long the version row says "Copied" after copying. */
const COPIED_MS = 1500

interface NoteStatusMenuProps {
  readonly sections: NoteDetailSections
  readonly state: NoteState
  /** The note the Private row toggles, or null where privacy is not a toggle. */
  readonly togglePath: string | null
}

const ITEM_SELECTOR = '[data-note-menu-item]:not(:disabled)'

/** Arrow keys, Home and End move between the menu's actionable rows. */
function moveFocus(event: KeyboardEvent<HTMLDivElement>): void {
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>(ITEM_SELECTOR)]
  if (items.length === 0) {
    return
  }
  const active = document.activeElement
  const current = active instanceof HTMLElement ? items.indexOf(active) : -1
  const target =
    event.key === 'ArrowDown'
      ? items[(current + 1) % items.length]
      : event.key === 'ArrowUp'
        ? items[(current - 1 + items.length) % items.length]
        : event.key === 'Home'
          ? items[0]
          : event.key === 'End'
            ? items.at(-1)
            : undefined
  if (target !== undefined) {
    event.preventDefault()
    target.focus()
  }
}

function editingIcon(detail: NoteDetail): ReactElement {
  switch (detail.value) {
    case 'Paused':
      return <FileWarning className="text-note-state-protected" />
    case 'Read-only':
      return <LockKeyhole />
    default:
      return <FileText />
  }
}

function backupIcon(detail: NoteDetail): ReactElement {
  switch (detail.value) {
    case 'Backed up':
      return <CloudCheck />
    case 'Sync failed':
      return <CloudAlert className="text-destructive" />
    case 'Syncing':
    case 'Checking':
      return <CloudUpload />
    default:
      return <CloudOff />
  }
}

/**
 * The status bar's note menu, styled like the app's dropdown menus: what this
 * note is (Private, which toggles where the flag is the note's own, and its
 * edit state), then how Git backup treats it, with the committed version one
 * keystroke from the clipboard.
 */
export function NoteStatusMenu({ sections, state, togglePath }: NoteStatusMenuProps): ReactElement {
  const [privacy, editing] = sections.note
  return (
    <div onKeyDown={moveFocus}>
      <NoteMenuSection label="This note">
        {togglePath !== null ? (
          <NotePrivacyAction path={togglePath} isPrivate={state.isPrivate} hint={privacy.hint} />
        ) : state.isLocalOnly ? (
          <NoteMenuRow
            icon={<HardDrive className="text-note-state-local-only" />}
            label={privacy.value}
            trailing="By folder"
            hint={privacy.hint}
          />
        ) : (
          <NoteMenuRow
            icon={<Shield className={state.isPrivate ? 'text-note-state-private' : undefined} />}
            label={privacy.value}
            hint={privacy.hint}
          />
        )}
        <NoteMenuRow icon={editingIcon(editing)} label={editing.value} hint={editing.hint} />
      </NoteMenuSection>
      <div className="my-1 h-px bg-border" />
      <NoteMenuSection label="Backup">
        {sections.backup.map((detail) =>
          detail.name === 'Version' && detail.monospace === true ? (
            <VersionRow key={detail.name} version={detail.value} />
          ) : (
            <NoteMenuRow
              key={detail.name}
              icon={detail.name === 'Version' ? <GitCommitHorizontal /> : backupIcon(detail)}
              label={detail.value}
              hint={detail.hint}
            />
          ),
        )}
      </NoteMenuSection>
    </div>
  )
}

interface VersionRowProps {
  readonly version: string
}

/** The committed version; activating the row copies it. */
function VersionRow({ version }: VersionRowProps): ReactElement {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) {
      return
    }
    const timer = setTimeout(() => setCopied(false), COPIED_MS)
    return () => clearTimeout(timer)
  }, [copied])

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(version)
      setCopied(true)
    } catch (cause) {
      startOperation('Copying version').fail(errorMessage(cause))
    }
  }

  return (
    <button
      type="button"
      data-note-menu-item
      aria-label={`Copy version ${version}`}
      onClick={() => void copy()}
      className={`${NOTE_MENU_ITEM} text-text-secondary`}
    >
      <GitCommitHorizontal />
      <span data-testid="note-menu-label" className="flex-1 truncate text-left font-mono text-xs">
        {version}
      </span>
      <span aria-live="polite" className="text-2xs text-text-muted">
        {copied ? 'Copied' : 'Copy'}
      </span>
    </button>
  )
}
