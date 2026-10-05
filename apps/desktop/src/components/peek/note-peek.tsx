import type { ReactElement } from 'react'
import { ArrowUpRight } from 'lucide-react'
import { dateFromDailyPath, displayNoteTitle } from '@reflect/core'
import { NotePane } from '@/components/note-pane.tsx'
import { useNoteRow } from '@/hooks/use-note-row.ts'
import { formatDayLabel } from '@/lib/dates.ts'
import { useSettings } from '@/providers/settings-provider.tsx'
import { useRouter } from '@/routing/router.tsx'
import { PEEK_HEADER_BUTTON } from './peek-header-button.ts'
import { PeekFrame } from './peek-frame.tsx'
import type { NotePeekTarget } from './peek-provider.tsx'

export interface NotePeekProps {
  target: NotePeekTarget
  onClose: () => void
}

/** A peeked note: fully editable, with "Open" promoting it to the main view. */
export function NotePeek({ target, onClose }: NotePeekProps): ReactElement {
  const { navigate } = useRouter()
  const { settings } = useSettings()
  const row = useNoteRow(target.path)
  const dailyDate = dateFromDailyPath(target.path)
  const title =
    dailyDate !== null
      ? formatDayLabel(dailyDate, settings.dateFormat)
      : row !== null
        ? displayNoteTitle(row.title)
        : ''

  return (
    <PeekFrame
      title={title || target.path}
      onClose={onClose}
      actions={
        <button
          type="button"
          aria-label="Open in main view"
          title="Open in main view"
          onClick={() => navigate(target.route)}
          className={PEEK_HEADER_BUTTON}
        >
          <ArrowUpRight aria-hidden className="size-4" strokeWidth={1.75} />
        </button>
      }
    >
      <div className="min-h-0 flex-1 overflow-auto py-6">
        {/* Publishes its outline: note commands such as "Jump to heading…"
            target the peeked note while it is open. */}
        <NotePane
          path={target.path}
          {...(dailyDate !== null ? { dailyDate } : {})}
          autoFocus
          outline
          reveal={target.reveal}
          className="flex min-h-full flex-col"
          gutterClassName="reflect-content-gutter"
          editorClassName="grow"
        />
      </div>
    </PeekFrame>
  )
}
