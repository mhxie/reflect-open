import type { ReactElement } from 'react'
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
import type { NoteProtection } from '@/editor/status/note-protection.ts'
import type {
  BackupDetail,
  EditingDetail,
  NoteDetailSections,
  VersionDetail,
} from '@/lib/note-details.ts'
import { startOperation } from '@/lib/operations.ts'
import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu.tsx'
import { toast } from '@/components/ui/toast.tsx'
import { NotePrivacyAction } from './note-privacy-action.tsx'
import { NOTE_MENU_ITEM, NoteMenuInfoItem, NoteMenuItemContent } from './note-menu-row.tsx'

const PROTECTION_TITLES: Record<NoteProtection['kind'], string> = {
  'sync-conflict': 'Sync conflict',
  'external-change': 'Changed on disk',
  'save-blocked': 'Saving blocked',
  'unsupported-markdown': 'Unsupported Markdown',
}

const SECTION_LABEL = 'px-2 pt-1.5 pb-0.5 text-2xs font-normal text-text-muted'

interface NoteStatusMenuProps {
  readonly sections: NoteDetailSections
  readonly state: NoteState
  /** Why editing is paused, or null when the note is not protected. */
  readonly protection: NoteProtection['kind'] | null
  /** The note the Private item toggles, or null where privacy is not a toggle. */
  readonly togglePath: string | null
  /** Open the recovery panel for a protected note. */
  readonly onResolve: () => void
}

function editingIcon(detail: EditingDetail): ReactElement {
  switch (detail.status) {
    case 'paused':
      return <FileWarning className="text-note-state-protected" />
    case 'read-only':
      return <LockKeyhole />
    case 'editable':
      return <FileText />
  }
}

function backupIcon(detail: BackupDetail): ReactElement {
  switch (detail.status) {
    case 'backed-up':
      return <CloudCheck />
    case 'failed':
      return <CloudAlert className="text-destructive" />
    case 'syncing':
    case 'checking':
      return <CloudUpload />
    case 'never':
    case 'off':
    case 'offline':
      return <CloudOff />
  }
}

async function copyVersion(version: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(version)
    toast.add({ title: 'Version copied' })
  } catch (cause) {
    startOperation('Copying version').fail(errorMessage(cause))
  }
}

interface VersionRowProps {
  readonly detail: VersionDetail
}

/** The Version row: a committed hash copies on Enter; anything else is a fact. */
function VersionRow({ detail }: VersionRowProps): ReactElement {
  if (detail.status !== 'committed') {
    return (
      <NoteMenuInfoItem icon={<GitCommitHorizontal />} label={detail.value} hint={detail.hint} />
    )
  }
  return (
    <DropdownMenuItem
      aria-label={`Copy version ${detail.value}`}
      onClick={() => void copyVersion(detail.value)}
      className={`${NOTE_MENU_ITEM} text-text-secondary`}
    >
      <NoteMenuItemContent
        icon={<GitCommitHorizontal />}
        label={detail.value}
        monospace
        trailing="Copy"
      />
    </DropdownMenuItem>
  )
}

/**
 * The status bar's note menu, on the app's menu primitive: what needs
 * attention, what this note is (Private toggles where the flag is the note's
 * own), then how Git backup treats it, with the committed version one Enter
 * from the clipboard. Facts are disabled items; only actions take focus.
 */
export function NoteStatusMenu({
  sections,
  state,
  protection,
  togglePath,
  onResolve,
}: NoteStatusMenuProps): ReactElement {
  const [privacy, editing] = sections.note
  const [backup, version] = sections.backup
  return (
    <>
      {protection === null ? null : (
        <>
          <DropdownMenuGroup>
            <DropdownMenuLabel className={SECTION_LABEL}>Needs attention</DropdownMenuLabel>
            <DropdownMenuItem onClick={onResolve} className={`${NOTE_MENU_ITEM} text-text`}>
              <NoteMenuItemContent
                icon={<FileWarning className="text-note-state-protected" />}
                label={PROTECTION_TITLES[protection]}
                trailing="Resolve…"
              />
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
        </>
      )}
      <DropdownMenuGroup>
        <DropdownMenuLabel className={SECTION_LABEL}>This note</DropdownMenuLabel>
        {togglePath !== null ? (
          <NotePrivacyAction path={togglePath} isPrivate={state.isPrivate} hint={privacy.hint} />
        ) : state.isLocalOnly ? (
          <NoteMenuInfoItem
            icon={<HardDrive className="text-note-state-local-only" />}
            label={privacy.value}
            trailing="By folder"
            hint={privacy.hint}
          />
        ) : (
          <NoteMenuInfoItem
            icon={<Shield className={state.isPrivate ? 'text-note-state-private' : undefined} />}
            label={privacy.value}
            hint={privacy.hint}
          />
        )}
        <NoteMenuInfoItem icon={editingIcon(editing)} label={editing.value} hint={editing.hint} />
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
      <DropdownMenuGroup>
        <DropdownMenuLabel className={SECTION_LABEL}>Backup</DropdownMenuLabel>
        <NoteMenuInfoItem icon={backupIcon(backup)} label={backup.value} hint={backup.hint} />
        {version === undefined ? null : <VersionRow detail={version} />}
      </DropdownMenuGroup>
    </>
  )
}
