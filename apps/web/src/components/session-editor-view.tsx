import { useCallback, useEffect, useMemo, useRef, type ReactElement, type RefObject } from 'react'
import type { ExitBoundaryHandler, SearchStatus } from '@meowdown/core'
import type { SelectionMenuSearchHandler } from '@meowdown/react'
import {
  deriveNoteState,
  findWikiClaim,
  formatRecencyLabel,
  isLocalOnlyPath,
  readWikiClaimIndex,
  splitWikiLinkTarget,
  wikiClaimHeadingText,
  wikiClaimId,
  type NoteSession,
  type NoteSessionSnapshot,
} from '@reflect/core'
import { getIsoToday } from '@reflect/utils'
import { KnowledgeLevelLabel } from '@/components/knowledge-level-label.tsx'
import { LocalOnlyNotice } from '@/components/local-only-notice.tsx'
import { NoteRecoveryBanner } from '@/components/note-recovery-banner.tsx'
import { PrivateNoteNotice } from '@/components/private-note-notice.tsx'
import { usePeek } from '@/components/peek/peek-provider.tsx'
import { WikiBreadcrumb } from '@/components/wiki/wiki-breadcrumb.tsx'
import { toast } from '@/components/ui/toast.tsx'
import { NoteTitlePresentationBridge } from '@/editor/note-title-presentation.tsx'
import { useNoteEmbedRenderer } from '@/editor/note-embed-reader.tsx'
import { OutlineBridge } from '@/editor/outline/outline-bridge.tsx'
import { WikiAnchorsBridge } from '@/editor/wiki-anchors/wiki-anchors-bridge.tsx'
import { WikiArticleBridge } from '@/editor/wiki-anchors/wiki-article-bridge.tsx'
import { noteArticleFor } from '@/editor/wiki-anchors/wiki-article-store.ts'
import { noteProtection } from '@/editor/status/note-protection.ts'
import { useNoteStatusPublisher } from '@/editor/status/use-note-status-publisher.ts'
import { useLocalOnlyFolders } from '@/hooks/use-local-only-folders.ts'
import type { NoteReveal } from '@/lib/note-reveal.ts'
import { useLinkIntentGuard } from '@/lib/windows/use-link-intent-guard.ts'
import { NoteSaveAlerts } from '@/components/note-save-alerts.tsx'
import { SuggestedContactCard } from '@/components/suggested-contact-card.tsx'
import { EditorAiKeymap } from '@/editor/ai-menu/editor-ai-keymap.tsx'
import { useEditorAiMenu } from '@/editor/ai-menu/use-editor-ai-menu.tsx'
import { editorBodyWithDefaultBullet } from '@/editor/default-bullet.ts'
import {
  registerNoteEditorHandle,
  unregisterNoteEditorHandle,
} from '@/editor/editor-handle-registry.ts'
import { markModeFromSyntax } from '@/editor/mark-mode.ts'
import { NoteEditor, type NoteEditorHandle } from '@/editor/note-editor.tsx'
import { useAssetPersistence } from '@/editor/use-asset-persistence.ts'
import { useEditorAutocomplete } from '@/editor/use-editor-autocomplete.ts'
import { useTagNavigation } from '@/editor/use-tag-navigation.ts'
import { useTemplateSlashItems } from '@/editor/use-template-slash-items.ts'
import { useMarkdownLinkClick } from '@/editor/use-markdown-link-click.ts'
import { useWikiLinkNavigation } from '@/editor/use-wiki-link-navigation.ts'
import { useWikiLinkHoverPreview } from '@/editor/use-wiki-link-hover-preview.tsx'
import { cn } from '@/lib/utils.ts'
import { useGraphInfo } from '@/providers/graph-provider.tsx'
import { useNoteSearchQuery, useNoteSearchReport } from '@/providers/note-find-provider.tsx'
import {
  useDateFormat,
  useEditorBulletAfterHeading,
  useEditorDefaultBullet,
  useEditorMarkdownSyntax,
  useEditorSmoothCaretAnimation,
  useEditorSpellCheck,
  useTimeFormat,
  useSettingsStore,
} from '@/providers/settings-provider.tsx'
import { useCoreServices } from '@/services/services-provider.tsx'

interface SessionEditorViewProps {
  /**
   * The session's path. Every path-addressed feature of the editor (assets,
   * links, AI, the handle registry, Find) uses this one; during a note switch
   * it briefly differs from the route's path.
   */
  path: string
  session: NoteSession
  /** The live state of this editor’s session. */
  snapshot: NoteSessionSnapshot
  /** The live privacy verdict, including local-only and index guards. */
  isPrivate: boolean
  /** The pane containing the editor, for selection status. */
  paneRef: RefObject<HTMLDivElement | null>
  outline: boolean
  reveal: NoteReveal | undefined
  onRevealed: ((key: number) => void) | undefined
  dailyNote: boolean
  autoFocus: boolean
  autoFocusSelection: 'start' | 'end'
  onAutoFocused: (() => void) | undefined
  /** Classes for the chrome around the editor (alerts, cards). */
  gutterClassName: string | undefined
  /** Classes for the contenteditable root. */
  editorClassName: string | undefined
  dailyDate: string | undefined
  registerHandle: ((date: string, handle: NoteEditorHandle | null) => void) | undefined
  onExitBoundary: ((date: string, direction: 'up' | 'down') => boolean) | undefined
}

/** Reveal an exact claim range, or an ordinary heading for non-claim fragments. */
function revealFragment(editor: NoteEditorHandle, fragment: string): boolean {
  if (wikiClaimId(fragment) !== null) {
    const claim = findWikiClaim(readWikiClaimIndex(editor.getMarkdown(), getIsoToday()), fragment)
    if (claim?.kind === 'range') return editor.revealSourceRange?.(claim.from, claim.to) ?? false
    else if (claim?.heading !== null && claim?.heading !== undefined)
      return editor.revealHeading(claim.heading)
    return false
  }
  return editor.revealHeading(wikiClaimHeadingText(editor.getMarkdown(), fragment) ?? fragment)
}

/**
 * The editor of one note session. Mounted once per session (the pane keys it
 * on the session's epoch), so everything here belongs to that session alone:
 * a rename re-renders it under the new path, a note switch replaces it.
 */
export function SessionEditorView({
  path,
  session,
  snapshot,
  isPrivate,
  paneRef,
  outline,
  reveal,
  onRevealed,
  dailyNote,
  autoFocus,
  autoFocusSelection,
  onAutoFocused,
  gutterClassName,
  editorClassName,
  dailyDate,
  registerHandle,
  onExitBoundary,
}: SessionEditorViewProps): ReactElement {
  const { initialContent, error: saveError, saveBlocked, recovery, titleMetadata } = snapshot
  const graph = useGraphInfo()
  const generation = graph?.generation ?? null
  const settings = useSettingsStore()
  const localOnlyFolders = useLocalOnlyFolders()
  const localOnly = isLocalOnlyPath(localOnlyFolders, path)
  const dateFormat = useDateFormat()
  const timeFormat = useTimeFormat()
  const editorMarkdownSyntax = useEditorMarkdownSyntax()
  const editorSpellCheck = useEditorSpellCheck()
  const editorSmoothCaretAnimation = useEditorSmoothCaretAnimation()
  const editorDefaultBullet = useEditorDefaultBullet()
  const editorBulletAfterHeading = useEditorBulletAfterHeading()
  const { platform, linkPreview } = useCoreServices()

  const openPeek = usePeek()?.openPeek
  const openPdf = useMemo(() => {
    return openPeek === undefined
      ? undefined
      : (pdfPath: string) => openPeek({ kind: 'pdf', path: pdfPath })
  }, [openPeek])
  const {
    resolveImageUrl,
    resolveEmbed,
    resolveWikiEmbed,
    resolveAssetOpenPath,
    resolveFileLink,
    openAsset,
    saveFile,
    resolveFileInfo,
    saveError: assetSaveError,
  } = useAssetPersistence(path, openPdf)
  const renderWikilinkHoverCard = useWikiLinkHoverPreview({
    dateFormat,
  })
  const followWikiLink = useWikiLinkNavigation({ readOnly: localOnly })
  const onLinkClick = useMarkdownLinkClick(path)
  const onTagClick = useTagNavigation()
  const { onWikilinkSearch, onTagSearch } = useEditorAutocomplete(path)
  const resolveLinkPreview = useMemo(
    () => (graph !== null && !localOnly ? linkPreview.createResolver(path) : undefined),
    [graph, localOnly, linkPreview, path],
  )

  // Find is one session per window: only the targeted note gets a query, and
  // only its status reaches the Find bar.
  const searchQuery = useNoteSearchQuery(path)
  const reportSearchStatus = useNoteSearchReport()
  const handleSearchChange = useCallback(
    (status: SearchStatus) => reportSearchStatus(path, status),
    [path, reportSearchStatus],
  )

  const editorRef = useRef<NoteEditorHandle | null>(null)
  // The `/` menu's template rows insert into this editor, read at select time
  // (a late resolve after the unmount must insert nowhere rather than
  // somewhere stale).
  const onSlashMenuSearch = useTemplateSlashItems(useCallback(() => editorRef.current, []))
  const revealInPane = useCallback((fragment: string): void => {
    const editor = editorRef.current
    if (editor === null) return
    if (!revealFragment(editor, fragment) && wikiClaimId(fragment) !== null) {
      toast.add({
        type: 'error',
        title: `Claim ${wikiClaimId(fragment)?.toUpperCase()} is missing or has invalid boundaries.`,
      })
    }
  }, [])
  const revealedKeyRef = useRef<number | null>(null)
  useEffect(() => {
    if (reveal === undefined || revealedKeyRef.current === reveal.key) return
    const frame = requestAnimationFrame(() => {
      revealedKeyRef.current = reveal.key
      revealInPane(reveal.fragment)
      onRevealed?.(reveal.key)
    })
    return () => cancelAnimationFrame(frame)
  }, [reveal, revealInPane, onRevealed])
  const beginLinkIntent = useLinkIntentGuard()
  const onWikiLinkClick = useCallback(
    (options: { target: string; openInNewWindow: boolean; peek?: boolean }) => {
      const { name, fragment } = splitWikiLinkTarget(options.target)
      if (name.trim() === '' && fragment !== null) {
        beginLinkIntent()
        revealInPane(fragment)
        return
      }
      followWikiLink(options)
    },
    [beginLinkIntent, followWikiLink, revealInPane],
  )
  const renderNoteEmbed = useNoteEmbedRenderer({
    sourcePath: path,
    generation,
    graphKey: graph?.root ?? null,
    remoteEmbeds: !isPrivate,
  })
  const aiMenu = useEditorAiMenu({ path, isPrivate, editorRef })

  const aiSelectionMenuSearch = aiMenu.onSelectionMenuSearch
  const onSelectionMenuSearch = useCallback<SelectionMenuSearchHandler>(
    async (query, context) => {
      const existing = (await aiSelectionMenuSearch?.(query, context)) ?? []
      if (dailyNote) return existing
      const article = noteArticleFor(path)
      const claims = article?.selectionClaims(context.from, context.to) ?? []
      const local: Awaited<ReturnType<SelectionMenuSearchHandler>> = [
        {
          id: 'mark-claim',
          label: 'Mark as claim',
          onSelect: (selection) => article?.markSelection(selection.from, selection.to),
        },
        ...claims.map((id) => ({
          id: `adjust-${id}`,
          label: `Set ${id.toUpperCase()} boundaries to selection`,
          onSelect: (selection: { from: number; to: number }) => {
            return article?.adjustSelection(id, selection.from, selection.to)
          },
        })),
        {
          id: 'copy-source',
          label: 'Copy Markdown source',
          onSelect: async (selection) => await article?.copySource(selection.from, selection.to),
        },
      ]
      return [
        ...local.filter((item) => item.label.toLowerCase().includes(query.trim().toLowerCase())),
        ...existing,
      ]
    },
    [aiSelectionMenuSearch, dailyNote, path],
  )

  const handleRef = useCallback(
    (handle: NoteEditorHandle) => {
      session.attachEditor(handle)
      editorRef.current = handle
      registerNoteEditorHandle(path, handle, generation)
      if (dailyDate !== undefined) {
        registerHandle?.(dailyDate, handle)
      }
      if (autoFocus) {
        // By default the caret lands at the document start — for a seeded
        // new note that is the empty H1, so typing names the note. An `end`
        // selection moves it (and the scroll) to the note's content end.
        handle.focus()
        if (autoFocusSelection === 'end') {
          handle.setSelection('end')
        }
        onAutoFocused?.()
      }
      return () => {
        // Runs while the handle is still live, so the session can still read
        // the editor's last input.
        session.attachEditor(null)
        editorRef.current = null
        unregisterNoteEditorHandle(path, handle)
        if (dailyDate !== undefined) {
          registerHandle?.(dailyDate, null)
        }
      }
    },
    [
      session,
      path,
      generation,
      dailyDate,
      registerHandle,
      autoFocus,
      autoFocusSelection,
      onAutoFocused,
    ],
  )
  const restoreRecovery = useCallback(() => session.restoreRecovery(), [session])
  const discardRecovery = useCallback(() => session.discardRecovery(), [session])
  const retrySave = useCallback(() => {
    void session.flush()
  }, [session])
  const getSelectedText = useCallback(() => editorRef.current?.getSelectedText() ?? '', [])
  const protection = useMemo(
    () => noteProtection({ ...snapshot, retrySave }),
    [snapshot, retrySave],
  )
  const publishStatus = useNoteStatusPublisher(
    generation === null ? null : { generation, path },
    initialContent,
    deriveNoteState(localOnlyFolders, {
      path,
      isPrivate,
      readOnly: false,
      protected: saveBlocked,
    }),
    { selection: { pane: paneRef, getSelectedText }, protection },
  )
  const onChange = useCallback(
    (markdown: string) => {
      session.editorChanged(markdown)
      publishStatus(markdown)
    },
    [session, publishStatus],
  )

  const handleExitBoundary: ExitBoundaryHandler | undefined = useMemo(() => {
    if (!dailyDate || !onExitBoundary) {
      return
    }
    return ({ direction }) => {
      return onExitBoundary(dailyDate, direction)
    }
  }, [dailyDate, onExitBoundary])

  // A note that opens with an empty body starts on an empty bullet when the
  // setting is on (old Reflect's every-note default). The seed only changes what
  // the editor shows; persistence is untouched, so a not-yet-created daily
  // placeholder stays uncreated until the user types — see `default-bullet.ts`.
  const editorSeed = editorBodyWithDefaultBullet(initialContent, editorDefaultBullet)

  return (
    <>
      <div className={gutterClassName}>
        <WikiBreadcrumb path={path} className="mb-1" />
        <KnowledgeLevelLabel path={path} className="mb-2 block" />
        {localOnly ? <LocalOnlyNotice editable className="mb-3" /> : null}
        {isPrivate && !localOnly ? (
          <PrivateNoteNotice path={path} interactive={settings.statusBarEnabled} className="mb-3" />
        ) : null}
        {recovery !== null ? (
          <NoteRecoveryBanner
            keptAt={formatRecencyLabel(recovery.savedAtMs, settings)}
            onRestore={restoreRecovery}
            onDiscard={discardRecovery}
          />
        ) : null}
        <NoteSaveAlerts
          saveError={saveError}
          saveBlocked={saveBlocked}
          retrySave={retrySave}
          assetSaveError={assetSaveError}
        />

        {/* Daily notes are date-titled, so a contact can never match one —
            the hook gates on it, and skipping the mount keeps the stream lean.
            Keyed by path: a rename must not carry one card's busy/error state
            into the next note's card. */}
        {!dailyNote ? <SuggestedContactCard key={path} path={path} /> : null}
      </div>

      <NoteEditor
        initialContent={editorSeed}
        privateNote={isPrivate}
        readOnly={saveBlocked}
        onChange={onChange}
        markMode={markModeFromSyntax(editorMarkdownSyntax)}
        spellCheck={editorSpellCheck}
        searchQuery={searchQuery}
        onSearchChange={handleSearchChange}
        smoothCaretAnimation={editorSmoothCaretAnimation}
        timeFormat={timeFormat}
        bulletAfterHeading={editorBulletAfterHeading}
        backspaceDeletesEmptyFirstBlock={dailyNote}
        // The grip drag-reorders blocks and the "+" inserts a paragraph below.
        blockHandle={true}
        resolveImageUrl={resolveImageUrl}
        resolveEmbed={resolveEmbed}
        resolveWikiEmbed={resolveWikiEmbed}
        renderNoteEmbed={renderNoteEmbed}
        resolveAssetOpenPath={resolveAssetOpenPath}
        openAsset={openAsset}
        saveFile={saveFile}
        // Claims links to local attachments (what saveFile inserts for a
        // dropped non-image file, or a vault's own attachment links) so they
        // render as file pills, sized by resolveFileInfo.
        resolveFileLink={resolveFileLink}
        resolveFileInfo={resolveFileInfo}
        onWikiLinkClick={onWikiLinkClick}
        onLinkClick={onLinkClick}
        resolveLinkPreview={resolveLinkPreview}
        renderWikilinkHoverCard={
          graph !== null && !platform.surface.touchEditor ? renderWikilinkHoverCard : undefined
        }
        onTagClick={onTagClick}
        onWikilinkSearch={onWikilinkSearch}
        onTagSearch={onTagSearch}
        onSelectionMenuSearch={onSelectionMenuSearch}
        pendingReplacementActions={aiMenu.pendingReplacementActions}
        onPendingReplacementResolve={aiMenu.onPendingReplacementResolve}
        onSlashMenuSearch={onSlashMenuSearch}
        // Daily notes carry no title semantics (the date is their subject),
        // so an empty leading H1 there is just an empty heading.
        {...(dailyNote ? {} : { titlePlaceholder: 'Untitled' })}
        // `reflect-note-surface` opts this primary editor into the reading
        // text size (Settings → Editor); compact MarkdownView previews that
        // also carry `reflect-editor` keep their own context size.
        className={cn('reflect-note-surface', gutterClassName, editorClassName)}
        handleRef={handleRef}
        onExitBoundary={handleExitBoundary}
      >
        <EditorAiKeymap onTrigger={aiMenu.openMenu} />
        <NoteTitlePresentationBridge
          metadata={markModeFromSyntax(editorMarkdownSyntax) === 'show' ? undefined : titleMetadata}
        />
        {outline ? <OutlineBridge path={path} /> : null}
        <WikiAnchorsBridge onWikiLinkClick={onWikiLinkClick} />
        <WikiArticleBridge path={path} onWikiLinkClick={onWikiLinkClick} />
      </NoteEditor>
    </>
  )
}
