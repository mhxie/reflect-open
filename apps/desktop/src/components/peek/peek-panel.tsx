import { useEffect, useRef, type KeyboardEvent, type ReactElement, type ReactNode } from 'react'
import { ArrowUpRight, ExternalLink, X } from 'lucide-react'
import { dateFromDailyPath, displayNoteTitle, errorMessage, openAsset } from '@reflect/core'
import { NotePane } from '@/components/note-pane.tsx'
import { useNoteRow } from '@/hooks/use-note-row.ts'
import { formatDayLabel } from '@/lib/dates.ts'
import { startOperation } from '@/lib/operations.ts'
import { useGraph } from '@/providers/graph-provider.tsx'
import { useSettings } from '@/providers/settings-provider.tsx'
import { useRouter } from '@/routing/router.tsx'
import { PdfPeekPages } from './pdf-peek-pages.tsx'
import { usePeek, type NotePeekTarget } from './peek-provider.tsx'

/** An editor menu (slash, tag, wiki-link, table) that is showing; they stay mounted closed. */
const OPEN_MENU = ':is([role="listbox"], [role="menu"])[data-state="open"]'

const HEADER_BUTTON =
  'flex size-7 items-center justify-center rounded-md text-text-muted hover:bg-surface-hover hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-text'

/**
 * The peeked note or PDF, floating over the editor pane: a note is fully
 * editable and "Open" promotes it to the main view; a PDF reads page by page
 * and can open in its default app. Esc, the close button, or a click outside
 * closes it, and so does any navigation.
 */
export function PeekPanel(): ReactElement | null {
  const peek = usePeek()
  const { route } = useRouter()
  const closePeek = peek?.closePeek
  const firstRoute = useRef(route)

  // A navigation (including the panel's own "Open") retires the peek.
  useEffect(() => {
    if (firstRoute.current !== route) {
      closePeek?.()
    }
    firstRoute.current = route
  }, [route, closePeek])

  if (peek?.target == null) {
    return null
  }
  const { target } = peek
  return target.kind === 'note' ? (
    <NotePeek key={target.path} target={target} onClose={peek.closePeek} />
  ) : (
    <PdfPeek key={target.path} path={target.path} onClose={peek.closePeek} />
  )
}

interface PeekFrameProps {
  title: string
  /** Header buttons before Close. */
  actions: ReactNode
  onClose: () => void
  children: ReactNode
}

/** The floating card every peek shares: backdrop, header, Esc to close. */
function PeekFrame({ title, actions, onClose, children }: PeekFrameProps): ReactElement {
  // Captured ahead of the editor, whose Esc collapses a selection: with
  // nothing selected and no editor menu open, Esc closes the peek instead.
  const closeOnEscape = (event: KeyboardEvent<HTMLDivElement>): void => {
    const selection = window.getSelection()
    if (
      event.key !== 'Escape' ||
      (selection !== null && !selection.isCollapsed) ||
      document.querySelector(OPEN_MENU) !== null
    ) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    onClose()
  }

  return (
    <div className="absolute inset-0 z-20 flex justify-center bg-text/10 px-10 py-8 backdrop-blur-[1px]">
      <button
        type="button"
        aria-label="Close peek"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 cursor-default"
      />
      <div
        role="dialog"
        aria-label={`Peek: ${title}`}
        onKeyDownCapture={closeOnEscape}
        className="relative flex h-full w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-2xl"
      >
        <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border/60 pr-2 pl-4">
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-text-secondary">
            {title}
          </span>
          {actions}
          <button
            type="button"
            aria-label="Close"
            title="Close (Esc)"
            onClick={onClose}
            className={HEADER_BUTTON}
          >
            <X aria-hidden className="size-4" strokeWidth={1.75} />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

function NotePeek({
  target,
  onClose,
}: {
  target: NotePeekTarget
  onClose: () => void
}): ReactElement {
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
          className={HEADER_BUTTON}
        >
          <ArrowUpRight aria-hidden className="size-4" strokeWidth={1.75} />
        </button>
      }
    >
      <div className="min-h-0 flex-1 overflow-auto py-6">
        <NotePane
          path={target.path}
          {...(dailyDate !== null ? { dailyDate } : {})}
          autoFocus
          reveal={target.reveal}
          className="flex min-h-full flex-col"
          gutterClassName="reflect-content-gutter"
          editorClassName="grow"
        />
      </div>
    </PeekFrame>
  )
}

function PdfPeek({ path, onClose }: { path: string; onClose: () => void }): ReactElement {
  const { graph } = useGraph()
  const generation = graph?.generation ?? null
  return (
    <PeekFrame
      title={path.slice(path.lastIndexOf('/') + 1)}
      onClose={onClose}
      actions={
        generation === null ? null : (
          <button
            type="button"
            aria-label="Open in default app"
            title="Open in default app"
            onClick={() => {
              openAsset(path, generation).catch((cause: unknown) => {
                startOperation('Opening attachment').fail(errorMessage(cause))
              })
            }}
            className={HEADER_BUTTON}
          >
            <ExternalLink aria-hidden className="size-4" strokeWidth={1.75} />
          </button>
        )
      }
    >
      {generation === null ? null : <PdfPeekPages generation={generation} path={path} />}
    </PeekFrame>
  )
}
