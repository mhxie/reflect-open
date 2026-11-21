import { useState, type DragEvent, type ReactElement } from 'react'
import { isWikiPath, type GraphInfo } from '@reflect/core'
import { FilePlus, Images, Library, ListChecks, MessageSquare, SquarePen } from 'lucide-react'
import { AudioMemoButton } from '@/components/audio-memo/audio-memo-button.tsx'
import { RecordingStrip } from '@/components/audio-memo/recording-strip.tsx'
import { ShortcutKeys } from '@/components/shortcut-keys.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import { ListIcon } from '@/components/icons/list-icon.tsx'
import { PencilIcon } from '@/components/icons/pencil-icon.tsx'
import { useHasWiki } from '@/hooks/use-has-wiki.ts'
import { useWikiLanguages } from '@/hooks/use-wiki-languages.ts'
import { usePinnedNotes } from '@/hooks/use-pinned-notes.ts'
import { keybindingFor } from '@/lib/commands/app-commands.ts'
import { createNoteFromFiles } from '@/lib/create-note-from-files.ts'
import { useToday } from '@/lib/use-today.ts'
import type { CommandContext } from '@/lib/commands/types.ts'
import { cn } from '@/lib/utils.ts'
import { notePathForRoute, rootSectionForRoute } from '@reflect/app'
import { useRouterState } from '@/routing/router.tsx'
import { useCoreServices } from '@/services/services-provider.tsx'
import { GraphFooter } from './graph-footer.tsx'
import { NavigateArrows } from './navigate-arrows.tsx'
import { SidebarItem } from './sidebar-item.tsx'
import { SidebarPinned } from './sidebar-pinned.tsx'
import { SidebarSearch } from './sidebar-search.tsx'

interface SidebarProps {
  graph: GraphInfo
  /** Commands run with this — the same context the palette/shortcuts use. */
  context: CommandContext
}

/**
 * The workspace sidebar, in the original app's shape: history arrows top
 * right, search with the compose and audio memo buttons, primary navigation with hover-revealed shortcut keycaps, the
 * Pinned shelf, and the graph switcher footer. Nav rows run registered
 * commands so a binding and its behavior stay one definition, and light for
 * the section of the screen on view. Daily notes is the exception: off the
 * stream it returns to the stream's last day, and on it it is the `Mod-D`
 * capture gesture (today, caret at the end). (Sidebar collapse stays on
 * `Mod-\` via the command registry.)
 */
export function Sidebar({ graph, context }: SidebarProps): ReactElement {
  const { platform } = useCoreServices()
  const { route, section } = useRouterState()
  const onDailySurface = route.kind === 'today' || route.kind === 'daily'
  const today = useToday()
  const pinned = usePinnedNotes()
  const currentNotePath = notePathForRoute(route, today)
  const hasActivePinnedNote =
    currentNotePath !== null && pinned.some((note) => note.path === currentNotePath)
  const hasWiki = useHasWiki()
  const wikiLanguages = useWikiLanguages()
  const openWikiNote =
    hasWiki &&
    route.kind === 'note' &&
    isWikiPath(route.path, wikiLanguages) &&
    !hasActivePinnedNote
  // A section row lights for the section of the screen on view. An open
  // pinned note lights its own row instead; the settings screens light none.
  const sectionRowsLit =
    (rootSectionForRoute(route) !== null || route.kind === 'note') && !hasActivePinnedNote
  const newNoteBinding = keybindingFor('note.new')

  // Wrap the 16px Lucide glyphs in the custom icons' 24px box so nav rows
  // share one icon footprint.
  const lucideBox = 'flex size-6 shrink-0 items-center justify-center'

  const generation = graph.generation
  const [dropping, setDropping] = useState(false)
  const carriesFiles = (event: DragEvent<HTMLDivElement>): boolean => {
    return event.dataTransfer.types.includes('Files')
  }

  return (
    <div
      onDragOver={(event) => {
        if (carriesFiles(event)) {
          event.preventDefault()
          event.dataTransfer.dropEffect = 'copy'
          setDropping(true)
        }
      }}
      onDragLeave={(event) => {
        const next = event.relatedTarget
        if (!(next instanceof Node && event.currentTarget.contains(next))) {
          setDropping(false)
        }
      }}
      onDrop={(event) => {
        if (!carriesFiles(event)) {
          return
        }
        event.preventDefault()
        setDropping(false)
        const files = [...event.dataTransfer.files]
        if (files.length > 0) {
          void createNoteFromFiles(files, generation, context)
        }
      }}
      className={cn(
        'relative flex h-full min-h-0 flex-col',
        // With the overlaid macOS title bar, the traffic lights and the
        // WindowDragRegion strip own the top 28px — start content below them.
        platform.hasMacosTitleBarOverlay ? 'pt-2' : 'pt-2.5',
      )}
    >
      <div className="flex flex-none items-center justify-end px-2 pt-1">
        <NavigateArrows />
      </div>

      <div className="flex flex-none flex-col">
        <div className="mt-1 flex items-center gap-1.5 px-4">
          <div className="min-w-0 flex-1">
            <SidebarSearch onOpen={() => context.openPalette()} />
          </div>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="New note"
                  onClick={() => void context.app.commands.run('note.new', context)}
                  className="text-text-muted hover:text-text-secondary dark:hover:text-text"
                >
                  <SquarePen aria-hidden strokeWidth={1.75} className="size-4" />
                </Button>
              }
            />
            <TooltipContent side="bottom">
              New note {newNoteBinding && <ShortcutKeys binding={newNoteBinding} />}
            </TooltipContent>
          </Tooltip>
          <AudioMemoButton />
        </div>
        <RecordingStrip />

        <nav aria-label="Primary" className="mt-6 space-y-1 px-4">
          <SidebarItem
            icon={<PencilIcon className="shrink-0" />}
            label="Daily notes"
            binding={keybindingFor('nav.today') ?? undefined}
            active={sectionRowsLit && section === 'daily'}
            onClick={() => {
              if (onDailySurface) {
                void context.app.commands.run('nav.today', context)
              } else {
                context.selectSection('daily')
              }
            }}
          />
          <SidebarItem
            icon={<ListIcon className="shrink-0" />}
            label="All notes"
            binding={keybindingFor('nav.allNotes') ?? undefined}
            active={sectionRowsLit && section === 'all' && !openWikiNote}
            onClick={() => void context.app.commands.run('nav.allNotes', context)}
          />
          {hasWiki ? (
            <SidebarItem
              icon={
                <span className={lucideBox}>
                  <Library aria-hidden strokeWidth={1.75} className="size-4" />
                </span>
              }
              label="Wiki"
              binding={keybindingFor('nav.wiki') ?? undefined}
              // Lit while reading an entry or its translation, which All notes
              // then leaves unlit — the same hand-off New note and All notes use.
              active={route.kind === 'wiki' || openWikiNote}
              onClick={() => void context.app.commands.run('nav.wiki', context)}
            />
          ) : null}
          <SidebarItem
            icon={
              <span className={lucideBox}>
                <Images aria-hidden strokeWidth={1.75} className="size-4" />
              </span>
            }
            label="Attachments"
            binding={keybindingFor('nav.attachments') ?? undefined}
            active={route.kind === 'attachments'}
            onClick={() => void context.app.commands.run('nav.attachments', context)}
          />
          <SidebarItem
            icon={
              <span className={lucideBox}>
                <ListChecks aria-hidden strokeWidth={1.75} className="size-4" />
              </span>
            }
            label="Tasks"
            binding={keybindingFor('nav.tasks') ?? undefined}
            active={sectionRowsLit && section === 'tasks'}
            onClick={() => void context.app.commands.run('nav.tasks', context)}
          />
          <SidebarItem
            icon={
              <span className={lucideBox}>
                <MessageSquare aria-hidden strokeWidth={1.75} className="size-4" />
              </span>
            }
            label="Chat"
            binding={keybindingFor('chat.open') ?? undefined}
            active={sectionRowsLit && section === 'chat'}
            onClick={() => void context.app.commands.run('chat.open', context)}
          />
        </nav>
      </div>

      <div className="mt-1 min-h-0 flex-1 overflow-y-auto pb-2">
        <SidebarPinned />
      </div>

      <GraphFooter graph={graph} context={context} />

      {dropping ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-2 z-20 flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-accent bg-accent-soft/80 text-sm font-medium text-accent backdrop-blur-[1px]"
        >
          <FilePlus strokeWidth={1.75} className="size-6" />
          Drop to create a note
        </div>
      ) : null}
    </div>
  )
}
