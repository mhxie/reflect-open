import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import {
  markdownToDoc,
  createMarkdownSourceMap,
  clipboardMarkdownWithReferences,
  type EditorExtension,
} from '@meowdown/core'
import { useEditor, useExtension } from '@meowdown/react'
import { TextSelection } from '@prosekit/pm/state'
import { planWikiClaim, planWikiClaimBoundary, type WikiArticleIndex } from '@reflect/core'
import { Popover, PopoverContent } from '@/components/ui/popover.tsx'
import { toast } from '@/components/ui/toast.tsx'
import { todayIso } from '@/lib/dates.ts'
import { openUrlSync } from '@/lib/open-url.ts'
import { whenEditorMounted } from '@/editor/when-editor-mounted.ts'
import { useSettings } from '@/providers/settings-provider.tsx'
import { clearNoteArticle, publishNoteArticle, useNoteArticle } from './wiki-article-store.ts'
import { useWikiArticleIdentities } from './use-wiki-article-identities.ts'
import { useWikiTrustView, type WikiTrustSummary } from './use-wiki-trust-view.ts'
import { wikiQuestionTransaction } from './wiki-claim-question.ts'
import { WikiClaimTrustCard } from './wiki-claim-trust-card.tsx'
import { defineWikiArticle, wikiArticleKey } from './wiki-article-plugin.tsx'
import { wikiEditorRange } from './wiki-article-projection.ts'
import type { WikiEvidenceOptions } from './wiki-evidence.ts'

/** Scopes one editor's hover rules, so two open notes' `c2` never light up together. */
let scopes = 0

/** Light up a claim while its trust mark is hovered or focused, without touching the editor's DOM. */
function highlightRules(scope: string, claimIds: readonly string[]): string {
  return claimIds
    .filter((id) => /^c[1-9]\d*$/.test(id))
    .map(
      (id) =>
        `[data-wiki-trust-scope="${scope}"]:has([data-wiki-trust-claim="${id}"]:is(:hover, :focus-visible)) [data-wiki-claim="${id}"]{background:color-mix(in srgb, var(--color-accent) 12%, transparent);border-radius:2px}`,
    )
    .join('\n')
}

interface WikiArticleBridgeProps {
  readonly path: string
  readonly onWikiLinkClick: NonNullable<WikiEvidenceOptions['openWikiLink']>
}

/** Hosts the note's shared claim projection and its local authoring action. */
export function WikiArticleBridge({ path, onWikiLinkClick }: WikiArticleBridgeProps): ReactElement {
  const editor = useEditor<EditorExtension>()
  const article = useNoteArticle(path)
  const noteIdentity = useWikiArticleIdentities(article?.index.source ?? '')
  const identitiesRef = useRef(noteIdentity)
  const updateRef = useRef<() => void>(() => {})
  const navigateRef = useRef(onWikiLinkClick)
  const display = useSettings().settings.wikiTrustDisplay
  const question = useCallback(
    (claimId: string) => {
      if (!editor.mounted || !editor.view.editable) return
      editor.view.dispatch(wikiQuestionTransaction(editor.state, claimId, todayIso()))
    },
    [editor],
  )
  const trust = useWikiTrustView(path, article?.index ?? null, question)
  const trustRef = useRef(trust.view)
  const summaryRef = useRef<WikiTrustSummary | null>(trust.summary)
  const [scope] = useState(() => `trust-${(scopes += 1)}`)
  const [cardFor, setCardFor] = useState<string | null>(null)
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
      trust: () => trustRef.current,
    }),
  )
  useExtension(extension)
  useEffect(() => {
    trustRef.current = trust.view
    summaryRef.current = trust.summary
    // A new article projection can publish from inside the editor's own view
    // update, rendering this synchronously; redraw after that update ends.
    let live = true
    queueMicrotask(() => {
      if (!live || !editor.mounted) return
      editor.view.dispatch(
        editor.state.tr.setMeta(wikiArticleKey, 'trust').setMeta('addToHistory', false),
      )
      updateRef.current()
    })
    return () => {
      live = false
    }
  }, [editor, trust.view, trust.summary])
  useEffect(() => {
    let detach = (): void => {}
    const cancel = whenEditorMounted(editor, () => {
      const dom = editor.view.dom
      dom.dataset['wikiTrustDisplay'] = display
      dom.dataset['wikiTrustScope'] = scope
      const click = (event: MouseEvent): void => {
        const mark =
          event.target instanceof Element
            ? event.target.closest<HTMLElement>('.wiki-trust-mark')
            : null
        const id = mark?.dataset['wikiTrustClaim']
        if (id === undefined) return
        event.preventDefault()
        setCardFor((current) => (current === id ? null : id))
      }
      dom.addEventListener('click', click)
      // Holding Option alone reveals every claim's tier; any other key with
      // it is a shortcut, so the reveal ends.
      const reveal = (on: boolean): void => {
        if (on) dom.dataset['wikiTrustReveal'] = ''
        else delete dom.dataset['wikiTrustReveal']
      }
      const keydown = (event: KeyboardEvent): void => reveal(event.key === 'Alt')
      const keyup = (event: KeyboardEvent): void => {
        if (event.key === 'Alt') reveal(false)
      }
      const blur = (): void => reveal(false)
      window.addEventListener('keydown', keydown)
      window.addEventListener('keyup', keyup)
      window.addEventListener('blur', blur)
      detach = () => {
        dom.removeEventListener('click', click)
        window.removeEventListener('keydown', keydown)
        window.removeEventListener('keyup', keyup)
        window.removeEventListener('blur', blur)
        reveal(false)
      }
    })
    return () => {
      cancel()
      detach()
    }
  }, [editor, display, scope])
  useEffect(() => {
    identitiesRef.current = noteIdentity
    if (editor.mounted)
      editor.view.dispatch(
        editor.state.tr.setMeta(wikiArticleKey, 'identities').setMeta('addToHistory', false),
      )
  }, [editor, noteIdentity])
  useEffect(() => {
    const owner = Symbol('wiki-article')
    let previous: {
      index: WikiArticleIndex
      showRanges: boolean
      trust: WikiTrustSummary | null
    } | null = null
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
      const trustSummary = summaryRef.current
      if (
        value === undefined ||
        (previous?.index === value.index &&
          previous.showRanges === value.showRanges &&
          previous.trust === trustSummary)
      )
        return
      previous = { index: value.index, showRanges: value.showRanges, trust: trustSummary }
      publishNoteArticle(path, owner, {
        index: value.index,
        showRanges: value.showRanges,
        trust: trustSummary,
        focusClaim: (id) => {
          const current = wikiArticleKey.getState(editor.state)
          const claim = current?.index.claims.find((item) => item.id === id)
          const range =
            current === undefined || claim === undefined
              ? null
              : wikiEditorRange(current.map, claim)
          if (range === null) return
          editor.view.dispatch(
            editor.state.tr
              .setSelection(
                TextSelection.create(
                  editor.state.doc,
                  TextSelection.near(editor.state.doc.resolve(range.from), 1).from,
                  TextSelection.near(editor.state.doc.resolve(range.to), -1).to,
                ),
              )
              .scrollIntoView(),
          )
          editor.focus()
        },
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
  const card = cardFor === null ? null : (trust.view?.claim(cardFor) ?? null)
  return (
    <>
      <style>{highlightRules(scope, article?.index.claims.map((claim) => claim.id) ?? [])}</style>
      {card === null ? null : (
        <Popover
          open
          onOpenChange={(open) => {
            if (!open) setCardFor(null)
          }}
        >
          <PopoverContent
            // Found again on each layout: a redraw replaces the mark's button.
            anchor={() =>
              editor.mounted
                ? editor.view.dom.querySelector(
                    `[data-wiki-trust-claim="${CSS.escape(card.claimId)}"]`,
                  )
                : null
            }
            side="top"
            align="start"
            className="w-72 max-w-[calc(100vw-2rem)] text-xs"
          >
            <WikiClaimTrustCard trust={card} />
          </PopoverContent>
        </Popover>
      )}
    </>
  )
}
