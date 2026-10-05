import { useEffect, useRef, useState } from 'react'
import { useEditor, useExtension } from '@meowdown/react'
import type { EditorExtension } from '@meowdown/core'
import { defineDocChangeHandler } from '@prosekit/core'
import { whenEditorMounted } from '../when-editor-mounted.ts'
import { outlineHeadingsEqual, type OutlineHeading } from './outline-headings.ts'
import { OUTLINE_EMBED_CHANGE, readOutlineWithEmbeds } from './outline-embeds.ts'
import {
  clearTailSpace,
  hasTailSpace,
  holdAtContainerTop,
  offsetFromContainerTop,
  verticalScrollContainer,
} from './outline-scroll.ts'
import { clearNoteOutline, publishNoteOutline } from './outline-store.ts'

/** Gap between the scroll container's top edge and a heading a jump lands, in px. */
const JUMP_TOP_MARGIN = 16

/**
 * Scroll-spy's line, as a fraction of the container height below its top
 * edge; floored so a short viewport still clears a jumped heading.
 */
const ACTIVE_LINE_FRACTION = 0.25
const ACTIVE_LINE_MIN = 32

/** How long a jump holds its heading at the top while content above settles. */
const ANCHOR_MS = 5000

interface OutlineBridgeProps {
  /** Graph-relative path the outline is published under. */
  path: string
}

/**
 * Publishes this editor's outline (headings, the section in view, and a jump)
 * to the outline store. Headings come from the live document, not the index,
 * because a jump needs exact editor positions. See docs/plans/26-note-outline.md.
 */
export function OutlineBridge({ path }: OutlineBridgeProps): null {
  const editor = useEditor<EditorExtension>()
  // Not meowdown's `onDocChange`, which skips `setMarkdown` (an external
  // reload). Doc-change handlers do not fire on mount; the effect reads the
  // initial outline itself.
  const docChangedRef = useRef<(() => void) | null>(null)
  const [docChangeExtension] = useState(() =>
    defineDocChangeHandler(() => docChangedRef.current?.()),
  )
  useExtension(docChangeExtension)

  useEffect(() => {
    const owner = Symbol('outline')
    let teardown: (() => void) | null = null

    const cancel = whenEditorMounted(editor, () => {
      const view = editor.view
      const container = verticalScrollContainer(view.dom)
      let headings: readonly OutlineHeading[] = []
      let activeIndex: number | null = null
      let spyFrame: number | null = null
      let mounted = true
      /** The jump being held at the top, if any. */
      let anchor: {
        index: number
        readonly heading: OutlineHeading
        readonly stop: () => void
      } | null = null

      function headingElement(heading: OutlineHeading): HTMLElement | null {
        if (heading.embedded !== undefined) return heading.embedded.element()
        const node = view.nodeDOM(heading.position)
        return node instanceof HTMLElement ? node : null
      }

      function measureActive(): number | null {
        if (container === null || headings.length === 0) {
          return null
        }
        // Scrolled to the very end, the last sections can never reach the
        // line: the end of the note is what is being read. Not with a jump's
        // tail space, which puts the scroll at its end by construction.
        const scrollable = container.scrollHeight > container.clientHeight
        const atEnd = container.scrollTop + container.clientHeight >= container.scrollHeight - 1
        const line = Math.max(ACTIVE_LINE_MIN, container.clientHeight * ACTIVE_LINE_FRACTION)
        let active: number | null = null
        for (const [index, heading] of headings.entries()) {
          const element = headingElement(heading)
          if (
            element !== null &&
            ((scrollable && atEnd && !hasTailSpace(container)) ||
              offsetFromContainerTop(container, element) <= line)
          )
            active = index
        }
        return active
      }

      function publish(): void {
        publishNoteOutline(path, owner, { headings, activeIndex, reveal })
      }

      function refreshActive(): void {
        spyFrame = null
        if (anchor !== null) {
          return // a jump pins its own heading until the reader takes over
        }
        const next = measureActive()
        if (next !== activeIndex) {
          activeIndex = next
          publish()
        }
      }

      function scheduleActiveRefresh(): void {
        if (spyFrame === null) {
          spyFrame = requestAnimationFrame(refreshActive)
        }
      }

      function refreshHeadings(): void {
        const next = readOutlineWithEmbeds(editor.state.doc, (position) => view.nodeDOM(position))
        if (outlineHeadingsEqual(next, headings)) {
          scheduleActiveRefresh()
          return
        }
        // A pinned jump follows its heading through position shifts — content
        // settling above it can write to the document too (a link card
        // persisting its resolved snapshot) — but not through a change to the
        // headings themselves.
        let pinnedIndex = anchor?.index
        if (anchor !== null) {
          if (anchor.heading.embedded !== undefined) {
            pinnedIndex = next.findIndex(
              (heading) => heading.embedded?.key === anchor?.heading.embedded?.key,
            )
          } else {
            const ownIndex =
              headings.slice(0, anchor.index + 1).filter((heading) => !heading.embedded).length - 1
            const own = next.filter((heading) => !heading.embedded)[ownIndex]
            pinnedIndex = own === undefined ? -1 : next.indexOf(own)
          }
        }
        const pinned = pinnedIndex === undefined ? undefined : next[pinnedIndex]
        if (
          anchor !== null &&
          (pinned === undefined ||
            pinned.text !== anchor.heading.text ||
            pinned.level !== anchor.heading.level ||
            pinned.embedded?.key !== anchor.heading.embedded?.key)
        ) {
          anchor.stop()
        } else if (anchor !== null && pinnedIndex !== undefined) {
          anchor.index = pinnedIndex
        }
        headings = next
        activeIndex = anchor?.index ?? measureActive()
        publish()
      }

      function reveal(index: number): void {
        if (!mounted) return
        const heading = headings[index]
        if (heading === undefined) {
          return
        }
        anchor?.stop()
        // Inside the heading's text, so the caret lands on the heading line.
        if (heading.embedded !== undefined) {
          heading.embedded.reveal()
        } else {
          editor.commands.selectText(heading.position + 1)
          editor.focus()
        }
        activeIndex = index
        publish()
        if (container === null) {
          return
        }

        const stop = holdAtContainerTop(
          container,
          () => {
            const current = headings[anchor?.index ?? index]
            return current === undefined ? null : headingElement(current)
          },
          JUMP_TOP_MARGIN,
          ANCHOR_MS,
          () => {
            if (anchor?.stop === stop) {
              anchor = null
            }
          },
        )
        anchor = { index, heading, stop }
      }

      docChangedRef.current = refreshHeadings
      container?.addEventListener('scroll', scheduleActiveRefresh, { passive: true })
      view.dom.addEventListener(OUTLINE_EMBED_CHANGE, refreshHeadings)
      window.addEventListener('resize', scheduleActiveRefresh)
      refreshHeadings()
      publish()

      teardown = () => {
        mounted = false
        docChangedRef.current = null
        container?.removeEventListener('scroll', scheduleActiveRefresh)
        view.dom.removeEventListener(OUTLINE_EMBED_CHANGE, refreshHeadings)
        window.removeEventListener('resize', scheduleActiveRefresh)
        if (spyFrame !== null) {
          cancelAnimationFrame(spyFrame)
        }
        anchor?.stop()
        if (container !== null) {
          clearTailSpace(container)
        }
        clearNoteOutline(path, owner)
      }
    })

    return () => {
      cancel()
      teardown?.()
    }
  }, [editor, path])

  return null
}
