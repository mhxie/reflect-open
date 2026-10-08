import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import type { EditorExtension } from '@meowdown/core'
import type { useEditor } from '@meowdown/react'
import type { WikiArticleIndex } from '@reflect/core'
import { Popover, PopoverContent } from '@/components/ui/popover.tsx'
import { todayIso } from '@/lib/dates.ts'
import { whenEditorMounted } from '@/editor/when-editor-mounted.ts'
import { useSettings } from '@/providers/settings-provider.tsx'
import { useWikiTrustView, type WikiNoteTrustSummary } from './use-wiki-trust-view.ts'
import { wikiQuestionTransaction } from './wiki-claim-question.ts'
import { WikiClaimTrustCard } from './wiki-claim-trust-card.tsx'
import { wikiArticleKey } from './wiki-article-plugin.tsx'
import type { WikiTrustView } from './wiki-trust-view.ts'

type Editor = ReturnType<typeof useEditor<EditorExtension>>

interface WikiArticleTrust {
  /** The current view, for the article plugin to draw. */
  readonly view: () => WikiTrustView | null
  /** The current footer summary, for the bridge to publish. */
  readonly summary: () => WikiNoteTrustSummary | null
  /** The open trust card, if any. */
  readonly card: ReactElement | null
}

/** The claim id of the trust mark at or around `target`. */
function markClaim(target: EventTarget | null | undefined): string | undefined {
  return target instanceof Element
    ? target.closest<HTMLElement>('.wiki-trust-mark')?.dataset['wikiTrustClaim']
    : undefined
}

/**
 * The editor's view while it accepts edits. A function, so render-time
 * dependency tracking never reads `editor.view` before the editor mounts.
 */
function editableView(editor: Editor): Editor['view'] | null {
  return editor.mounted && editor.view.editable ? editor.view : null
}

/** A text field outside the editor, where Option belongs to typing. */
function inOtherField(target: EventTarget | null, editorDom: HTMLElement): boolean {
  return (
    target instanceof HTMLElement &&
    !editorDom.contains(target) &&
    (target.isContentEditable || target.matches('input, textarea, select'))
  )
}

/**
 * Claim trust for one open article: the harness's verdicts for the plugin to
 * draw, the reading style and Option reveal on the editor's DOM, and the card
 * a mark opens. `published` runs after each redraw so the footer follows.
 */
export function useWikiArticleTrust(
  editor: Editor,
  path: string,
  index: WikiArticleIndex | null,
  published: { readonly current: () => void },
): WikiArticleTrust {
  const display = useSettings().settings.wikiTrustDisplay
  const question = useCallback(
    (claimId: string) => {
      const view = editableView(editor)
      view?.dispatch(wikiQuestionTransaction(view.state, claimId, todayIso()))
      return view !== null
    },
    [editor],
  )
  const trust = useWikiTrustView(path, index, question)
  const viewRef = useRef(trust.view)
  const summaryRef = useRef(trust.summary)
  const [cardFor, setCardFor] = useState<string | null>(null)
  useEffect(() => {
    viewRef.current = trust.view
    summaryRef.current = trust.summary
    // A new article projection can publish from inside the editor's own view
    // update, rendering this synchronously; redraw after that update ends.
    let live = true
    queueMicrotask(() => {
      if (!live) return
      if (trust.view === null) setCardFor(null)
      if (!editor.mounted) return
      editor.view.dispatch(
        editor.state.tr.setMeta(wikiArticleKey, 'trust').setMeta('addToHistory', false),
      )
      published.current()
    })
    return () => {
      live = false
    }
  }, [editor, published, trust.view, trust.summary])
  useEffect(() => {
    let detach = (): void => {}
    const cancel = whenEditorMounted(editor, () => {
      const dom = editor.view.dom
      dom.dataset['wikiTrustDisplay'] = display
      const click = (event: MouseEvent): void => {
        const id = markClaim(event.target)
        if (id === undefined) return
        event.preventDefault()
        setCardFor((current) => (current === id ? null : id))
      }
      dom.addEventListener('click', click)
      // Holding Option reveals every claim's tier and mark, and lasts through
      // Option+Tab so the keyboard can reach a mark.
      const reveal = (on: boolean): void => {
        if (on) dom.dataset['wikiTrustReveal'] = ''
        else delete dom.dataset['wikiTrustReveal']
      }
      const keydown = (event: KeyboardEvent): void =>
        reveal(event.altKey && !inOtherField(event.target, dom))
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
  }, [editor, display])

  const open = cardFor === null ? null : (trust.view?.claim(cardFor) ?? null)
  const card =
    open === null ? null : (
      <Popover
        open
        onOpenChange={(next, details) => {
          // A press on the open card's own mark is left to its click, which closes it.
          if (
            !next &&
            !(
              details.reason === 'outside-press' && markClaim(details.event.target) === open.claimId
            )
          )
            setCardFor(null)
        }}
      >
        <PopoverContent
          // Found again on each layout: a redraw replaces the mark's button.
          anchor={() =>
            editor.mounted
              ? editor.view.dom.querySelector(
                  `[data-wiki-trust-claim="${CSS.escape(open.claimId)}"]`,
                )
              : null
          }
          side="top"
          align="start"
          className="max-h-[min(var(--available-height),28rem)] w-72 max-w-[calc(100vw-2rem)] overflow-y-auto text-xs"
        >
          <WikiClaimTrustCard
            key={open.claimId}
            trust={open}
            // Checked as the card renders: the note may have turned read-only since.
            editable={editableView(editor) !== null}
          />
        </PopoverContent>
      </Popover>
    )

  const view = useCallback(() => viewRef.current, [])
  const summary = useCallback(() => summaryRef.current, [])
  return { view, summary, card }
}
