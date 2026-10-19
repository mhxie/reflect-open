import { useCallback, useEffect, useMemo, useRef } from 'react'
import { getIsComposing } from '@meowdown/core'
import { usePalette } from '@/components/command-palette/palette-provider.tsx'
import { usePeekedNotePath } from '@/components/peek/peek-provider.tsx'
import { requestNoteMenu } from '@/editor/status/note-menu-request.ts'
import { usePinnedNotes } from '@/hooks/use-pinned-notes.ts'
import { todayIso } from '@/lib/dates.ts'
import type { CommandContext } from '@/lib/commands/types.ts'
import { toggleNotePrivate } from '@/lib/note-privacy-toast.ts'
import { useAudioMemo } from '@/providers/audio-memo-provider.tsx'
import { useMaybeChatSession } from '@/providers/chat-provider.tsx'
import { useFocusedDailyDate } from '@/providers/focused-daily-provider.tsx'
import { useGraph } from '@/providers/graph-provider.tsx'
import { useHeadingPicker } from '@/providers/heading-picker-provider.tsx'
import { useNoteFindActions } from '@/providers/note-find-provider.tsx'
import { useNoteTemplates } from '@/providers/note-templates-provider.tsx'
import { useSettings } from '@/providers/settings-provider.tsx'
import { useShortcuts } from '@/providers/shortcuts-provider.tsx'
import { useSidebar } from '@/providers/sidebar-provider.tsx'
import { useTheme } from '@/providers/theme-provider.tsx'
import { useAppServices, useCoreServices } from '@/services/services-provider.tsx'
import { focusedNotePathForRoute, routeForPath } from './route.ts'
import { useRouter } from './router.tsx'

/**
 * App-scope keyboard shortcuts, driven by the command registry (Plan 08): a
 * binding and its behavior are one command definition — the switch statement
 * this file used to hold is gone. Bindings still register in the central
 * keymap registry, the shared collision ledger with editor-scope keys
 * (`registerAppKeymaps`).
 */

const HISTORY_COMMAND_IDS = new Set(['history.back', 'history.forward'])

// A mouse's side buttons, as `MouseEvent.button` numbers them. On macOS, wry
// re-dispatches them as synthetic `mouseup`s and, unless one is cancelled,
// falls back to `window.history`, which this router never writes.
const MOUSE_BUTTON_TO_HISTORY_ID: ReadonlyMap<number, string> = new Map([
  [3, 'history.back'],
  [4, 'history.forward'],
])

// AppKit owns this key equivalent on macOS. Keep it in the registry for
// display, collision detection, and the plain-browser/non-macOS fallback, but
// do not consume its keydown in the webview before the native menu sees it.
const NATIVE_MACOS_MENU_COMMAND_IDS = new Set([
  'sidebar.toggle',
  'note.find',
  'note.findNext',
  'note.findPrevious',
])

/**
 * Install the app-level shortcut listener and build the {@link CommandContext}
 * commands run with. Mount once inside the router + palette providers; the
 * returned context is also what the palette itself runs commands through, and
 * the native menu's command items dispatch into the same guard path while
 * mounted (`setMenuCommandDispatch`).
 */

function doNothing(): void {}

export function useAppShortcuts(): CommandContext {
  const services = useCoreServices()
  const appServices = useAppServices()
  const { route, navigate, back, forward, clearScrollState } = useRouter()
  const { platform, semanticSearch } = services
  const { commands, nativeMenu } = appServices
  const focusedDailyDate = useFocusedDailyDate()
  const peekedPath = usePeekedNotePath()
  const { resolvedTheme, setTheme } = useTheme()
  const { graph, recents, openRecent } = useGraph()
  // Keeps the shared pinned query active while the workspace sidebar is
  // collapsed, so ⌘1–⌘0 always see the shelf in its sidebar order.
  const pinnedNotes = usePinnedNotes()
  const { openPalette, open: paletteOpen } = usePalette()
  const { openShortcuts, closeShortcuts, open: shortcutsOpen } = useShortcuts()
  const {
    openTemplatePicker,
    openTemplateCreate,
    pickerOpen: templatePickerOpen,
    createOpen: templateCreateOpen,
  } = useNoteTemplates()
  const { openHeadingPicker, open: headingPickerOpen } = useHeadingPicker()
  const { toggleSidebar } = useSidebar()
  const { toggle: toggleAudioMemo } = useAudioMemo()
  // The hook can outlive the open graph, and its chat session with it.
  const newChat = useMaybeChatSession()?.newChat ?? doNothing
  const { settings, updateSettings, updateSettingsWith } = useSettings()
  const {
    openForPath: openNoteFindForPath,
    next: findNextInNote,
    previous: findPreviousInNote,
  } = useNoteFindActions()

  // The palette is modal: app shortcuts must not navigate behind its overlay.
  // A ref keeps the listener stable across open/close renders.
  const paletteOpenRef = useRef(paletteOpen)

  // Same for the ⌘/ cheat-sheet, except ⌘/ itself toggles it closed.
  const shortcutsOpenRef = useRef(shortcutsOpen)

  // And for the template dialogs — both are Radix modals; nothing may
  // navigate behind them.
  const templatesOpenRef = useRef(templatePickerOpen || templateCreateOpen)

  // And for the heading picker, another modal dialog.
  const headingPickerOpenRef = useRef(headingPickerOpen)

  // Read at run time, not captured: a command can fire long after the render
  // that created the context (palette open across an index rebuild, etc.).
  const graphRootRef = useRef<string | null>(graph?.root ?? null)
  const recentsRef = useRef(recents)
  const openRecentRef = useRef(openRecent)
  const routeRef = useRef(route)
  const focusedDailyDateRef = useRef(focusedDailyDate)
  const peekedPathRef = useRef(peekedPath)
  const pinnedNotesRef = useRef(pinnedNotes)
  const wikiLanguagesRef = useRef(settings.wikiLanguages)
  // The note being worked on: a peeked note, else the focused stream day (so a
  // note-scoped command targets the day the context sidebar shows — see
  // `effectiveDailyDate`), else the routed note.
  const workingNotePath = useCallback((): string | null => {
    return (
      peekedPathRef.current ??
      focusedNotePathForRoute(routeRef.current, todayIso(), focusedDailyDateRef.current)
    )
  }, [])
  useEffect(() => {
    paletteOpenRef.current = paletteOpen
    shortcutsOpenRef.current = shortcutsOpen
    templatesOpenRef.current = templatePickerOpen || templateCreateOpen
    headingPickerOpenRef.current = headingPickerOpen
    graphRootRef.current = graph?.root ?? null
    recentsRef.current = recents
    openRecentRef.current = openRecent
    routeRef.current = route
    focusedDailyDateRef.current = focusedDailyDate
    peekedPathRef.current = peekedPath
    pinnedNotesRef.current = pinnedNotes
    wikiLanguagesRef.current = settings.wikiLanguages
  })

  const context = useMemo<CommandContext>(
    () => ({
      services,
      app: appServices,
      navigate,
      route: () => routeRef.current,
      notePath: workingNotePath,
      togglePin: async () => {
        const path = workingNotePath()
        if (path !== null) {
          await services.noteActions.togglePinned(path)
        }
      },
      togglePrivate: async () => {
        const path = workingNotePath()
        if (path !== null) {
          // The toast names the new state and offers Undo.
          await toggleNotePrivate(services.noteActions, path)
        }
      },
      showNoteDetails: () => {
        const path = workingNotePath()
        if (path !== null) {
          requestNoteMenu(path)
        }
      },
      back,
      forward,
      clearScrollState,
      toggleTheme: () => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark'),
      toggleSidebar,
      newChat,
      openNoteFind: () => {
        openNoteFindForPath(workingNotePath())
      },
      findNextInNote,
      findPreviousInNote,
      switchGraph: (index) => {
        const recent = recentsRef.current[index]
        if (recent === undefined || recent.root === graphRootRef.current) {
          return
        }
        void openRecentRef.current(recent.root)
      },
      openPinnedNote: (index) => {
        if (graphRootRef.current === null) {
          return
        }
        const note = pinnedNotesRef.current[index]
        if (note !== undefined) {
          navigate(routeForPath(note.path), { focusEditor: true })
        }
      },
      toggleAudioMemo,
      openPalette,
      openShortcuts,
      openTemplatePicker,
      openTemplateCreate,
      openHeadingPicker,
      enableSemanticSearch: () => {
        updateSettings({ semanticSearchEnabled: true })
        // EmbeddingsSync loads an untouched runtime; a `failed` one only
        // retries on an explicit action like this command.
        void semanticSearch.retryFailedModel()
      },
      sortAllNotes: (update) => {
        updateSettingsWith((current) => ({ allNotesSort: update(current.allNotesSort) }))
      },
      wikiLanguages: () => wikiLanguagesRef.current,
    }),
    [
      services,
      appServices,
      navigate,
      workingNotePath,
      back,
      forward,
      clearScrollState,
      resolvedTheme,
      setTheme,
      openPalette,
      openShortcuts,
      openTemplatePicker,
      openTemplateCreate,
      openHeadingPicker,
      toggleSidebar,
      newChat,
      openNoteFindForPath,
      findNextInNote,
      findPreviousInNote,
      toggleAudioMemo,
      updateSettings,
      updateSettingsWith,
      semanticSearch,
    ],
  )

  useEffect(() => {
    function idForKeyDown(event: KeyboardEvent): string | null {
      return commands.commandForKeyDown(event)
    }

    function isNativeMacosMenuCommand(commandId: string): boolean {
      return (
        platform.isMacosDesktop &&
        nativeMenu.isInstalled() &&
        NATIVE_MACOS_MENU_COMMAND_IDS.has(commandId)
      )
    }

    // The one guarded entry point for app commands, shared by keystrokes and
    // native menu activations. Returns whether the command was handled.
    function triggerCommand(id: string): boolean {
      if (paletteOpenRef.current) {
        return false // modal palette owns the screen; Esc closes, then commands resume
      }
      if (shortcutsOpenRef.current) {
        // The cheat-sheet is modal too: nothing may navigate behind it, but
        // the command that opened it closes it again.
        if (id === 'shortcuts.show') {
          closeShortcuts()
          return true
        }
        return false
      }
      if (templatesOpenRef.current) {
        return false // the template picker/create dialogs are modal too
      }
      if (headingPickerOpenRef.current) {
        return false // so is the heading picker
      }
      void commands.run(id, context)
      return true
    }

    function onHistoryKeyDownCapture(event: KeyboardEvent) {
      if (getIsComposing()) {
        return
      }
      const id = idForKeyDown(event)
      if (id === null || isNativeMacosMenuCommand(id) || !HISTORY_COMMAND_IDS.has(id)) {
        return
      }
      if (triggerCommand(id)) {
        // History navigation is app chrome, so it wins even when the focused
        // editor would otherwise consume the bracket chord while bubbling.
        event.preventDefault()
      }
    }

    // No composition guard: unlike a keystroke, a button press is never IME input.
    function onHistoryMouseUpCapture(event: MouseEvent) {
      const id = MOUSE_BUTTON_TO_HISTORY_ID.get(event.button)
      if (id !== undefined && triggerCommand(id)) {
        // Captured like the bracket chords, so no surface under the pointer
        // can swallow it; cancelling also skips wry's `window.history` fallback.
        event.preventDefault()
      }
    }

    function onKeyDown(event: KeyboardEvent) {
      if (getIsComposing()) {
        return
      }
      if (event.defaultPrevented) {
        // The focused editor gets first refusal. meowdown's `Mod-k` consumes the
        // keydown (preventDefault) only when it turns a selection or the link at
        // the caret into a link; the palette must not also open. When the editor
        // has nothing to do it leaves the event alone and `Mod-k` falls through.
        return
      }
      const id = idForKeyDown(event)
      if (id === null || isNativeMacosMenuCommand(id)) {
        return
      }
      if (triggerCommand(id)) {
        // Also keeps the native menu's matching accelerator from firing the
        // same command again: the webview consumes the key equivalent.
        event.preventDefault()
      }
    }

    nativeMenu.setCommandDispatch(triggerCommand)
    window.addEventListener('keydown', onHistoryKeyDownCapture, { capture: true })
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('mouseup', onHistoryMouseUpCapture, { capture: true })
    return () => {
      nativeMenu.setCommandDispatch(null)
      window.removeEventListener('keydown', onHistoryKeyDownCapture, true)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('mouseup', onHistoryMouseUpCapture, true)
    }
  }, [context, closeShortcuts, commands, nativeMenu, platform])

  return context
}
