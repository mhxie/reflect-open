import { useEffect, useRef, useState } from 'react'
import {
  markdownToDoc,
  createMarkdownSourceMap,
  clipboardMarkdownWithReferences,
  type EditorExtension,
} from '@meowdown/core'
import { useEditor, useExtension } from '@meowdown/react'
import { TextSelection } from '@prosekit/pm/state'
import { planWikiClaim, planWikiClaimBoundary, type WikiArticleIndex } from '@reflect/core'
import { toast } from '@/components/ui/toast.tsx'
import { todayIso } from '@/lib/dates.ts'
import { openUrlSync } from '@/lib/open-url.ts'
import { whenEditorMounted } from '@/editor/when-editor-mounted.ts'
import { clearNoteArticle, publishNoteArticle, useNoteArticle } from './wiki-article-store.ts'
import { useWikiArticleIdentities } from './use-wiki-article-identities.ts'
import { defineWikiArticle, wikiArticleKey } from './wiki-article-plugin.tsx'
import { wikiEditorRange } from './wiki-article-projection.ts'
import type { WikiEvidenceOptions } from './wiki-evidence.ts'

interface WikiArticleBridgeProps {
  readonly path: string
  readonly onWikiLinkClick: NonNullable<WikiEvidenceOptions['openWikiLink']>
}

/** Hosts the note's shared claim projection and its local authoring action. */
export function WikiArticleBridge({ path, onWikiLinkClick }: WikiArticleBridgeProps): null {
  const editor = useEditor<EditorExtension>()
  const article = useNoteArticle(path)
  const noteIdentity = useWikiArticleIdentities(article?.index.source ?? '')
  const identitiesRef = useRef(noteIdentity)
  const updateRef = useRef<() => void>(() => {})
  const navigateRef = useRef(onWikiLinkClick)
  useEffect(() => {
    navigateRef.current = onWikiLinkClick
  }, [onWikiLinkClick])
  const [extension] = useState(() =>
    defineWikiArticle({
      asOf: todayIso,
      evidence: {
        interactive: true,
        openUrl: openUrlSync,
        openWikiLink: (options) => navigateRef.current(options),
      },
      onUpdate: () => updateRef.current(),
      noteIdentity: (title) => identitiesRef.current(title),
    }),
  )
  useExtension(extension)
  useEffect(() => {
    identitiesRef.current = noteIdentity
    if (editor.mounted)
      editor.view.dispatch(
        editor.state.tr.setMeta(wikiArticleKey, 'identities').setMeta('addToHistory', false),
      )
  }, [editor, noteIdentity])
  useEffect(() => {
    const owner = Symbol('wiki-article')
    let previous: { index: WikiArticleIndex; showRanges: boolean } | null = null
    function markSelection(from: number, to: number, id?: string): void {
      if (!editor.mounted || !editor.view.editable) return
      const value = wikiArticleKey.getState(editor.state)
      const sourceFrom = value?.map.editorToSource(from, 1) ?? null
      const sourceTo = value?.map.editorToSource(to, -1) ?? null
      if (value === undefined || sourceFrom === null || sourceTo === null) {
        toast.add({ type: 'error', title: 'Select prose with supported Markdown boundaries.' })
        return
      }
      const plan =
        id === undefined
          ? planWikiClaim(value.index.source, sourceFrom, sourceTo, todayIso())
          : planWikiClaimBoundary(value.index.source, id, sourceFrom, sourceTo, todayIso())
      if (!plan.ok) {
        toast.add({ type: 'error', title: plan.message })
        return
      }
      const doc = markdownToDoc(plan.source, { nodes: editor.nodes })
      const map = createMarkdownSourceMap(doc)
      const first = map.sourceToEditor(plan.from, 1)
      const last = map.sourceToEditor(plan.to, -1)
      if (first === null || last === null) {
        toast.add({ type: 'error', title: 'The selected range cannot be mapped into the editor.' })
        return
      }
      const transaction = editor.state.tr.replaceWith(0, editor.state.doc.content.size, doc.content)
      transaction
        .setSelection(
          TextSelection.create(
            transaction.doc,
            TextSelection.near(transaction.doc.resolve(first), 1).from,
            TextSelection.near(transaction.doc.resolve(last), -1).to,
          ),
        )
        .scrollIntoView()
      editor.view.dispatch(transaction)
      editor.focus()
    }
    function publish(): void {
      if (!editor.mounted) return
      const value = wikiArticleKey.getState(editor.state)
      if (
        value === undefined ||
        (previous?.index === value.index && previous.showRanges === value.showRanges)
      )
        return
      previous = { index: value.index, showRanges: value.showRanges }
      publishNoteArticle(path, owner, {
        index: value.index,
        showRanges: value.showRanges,
        toggleRanges: () => {
          if (editor.mounted)
            editor.view.dispatch(
              editor.state.tr.setMeta(wikiArticleKey, 'toggle').setMeta('addToHistory', false),
            )
        },
        markSelection,
        selectionClaims: (from, to) => {
          const sourceFrom = value.map.editorToSource(from, 1)
          const sourceTo = value.map.editorToSource(to, -1)
          return sourceFrom === null || sourceTo === null
            ? []
            : value.index.claims
                .filter(
                  (claim) =>
                    claim.kind === 'range' && sourceFrom < claim.to && sourceTo > claim.from,
                )
                .map((claim) => claim.id)
        },
        adjustSelection: (id, from, to) => {
          markSelection(from, to, id)
        },
        copySource: async (from, to) => {
          const current = wikiArticleKey.getState(editor.state)
          let sourceFrom = current?.map.editorToSource(from, 1) ?? null
          let sourceTo = current?.map.editorToSource(to, -1) ?? null
          if (current === undefined || sourceFrom === null || sourceTo === null) return
          for (const claim of current.index.claims) {
            const range = wikiEditorRange(current.map, claim)
            if (
              range !== null &&
              from <= TextSelection.near(editor.state.doc.resolve(range.from), 1).from &&
              to >= TextSelection.near(editor.state.doc.resolve(range.to), -1).to
            ) {
              sourceFrom = Math.min(sourceFrom, claim.open?.from ?? claim.from)
              sourceTo = Math.max(sourceTo, claim.close?.to ?? claim.to)
            }
          }
          const source = clipboardMarkdownWithReferences(
            current.index.source.slice(sourceFrom, sourceTo),
            editor.state.doc.slice(from, to, true),
            editor.state.doc,
          )
          try {
            await navigator.clipboard.writeText(source)
          } catch {
            toast.add({ type: 'error', title: 'The clipboard is unavailable.' })
          }
        },
      })
    }
    updateRef.current = publish
    const cancel = whenEditorMounted(editor, publish)
    return () => {
      cancel()
      updateRef.current = () => {}
      clearNoteArticle(path, owner)
    }
  }, [editor, path])
  return null
}
