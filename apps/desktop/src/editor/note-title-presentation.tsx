import { useEffect, useState } from 'react'
import { useEditor, useExtension } from '@meowdown/react'
import { definePlugin } from '@prosekit/core'
import { Plugin, PluginKey, TextSelection } from '@prosekit/pm/state'
import { Decoration, DecorationSet } from '@prosekit/pm/view'
import { noteTitlePresentation, type NoteTitleMetadata } from '@reflect/core'
import { whenEditorMounted } from './when-editor-mounted.ts'

interface TitleState {
  metadata: NoteTitleMetadata
  focused: boolean
}
const titleKey = new PluginKey<TitleState>('reflect-note-title-presentation')

function languageBadge(text: string): HTMLElement {
  const badge = document.createElement('sup')
  badge.className = 'reflect-title-language'
  badge.textContent = text
  badge.contentEditable = 'false'
  badge.style.cssText =
    'font-size:.48em;font-weight:400;opacity:.6;margin-left:.4em;vertical-align:super;'
  badge.setAttribute('aria-hidden', 'true')
  return badge
}

function defineTitlePresentation(metadata: NoteTitleMetadata) {
  return definePlugin(
    new Plugin<TitleState>({
      key: titleKey,
      state: {
        init: () => ({ metadata, focused: false }),
        apply: (tr, value) => ({
          ...value,
          ...(tr.getMeta(titleKey) as Partial<TitleState> | undefined),
        }),
      },
      view(view) {
        let destroyed = false
        // Extensions can install after the parent autofocuses the editor.
        queueMicrotask(() => {
          if (destroyed) return
          const focused = view.hasFocus()
          if (titleKey.getState(view.state)?.focused !== focused) {
            view.dispatch(
              view.state.tr.setMeta(titleKey, { focused }).setMeta('addToHistory', false),
            )
          }
        })
        return {
          destroy: () => {
            destroyed = true
          },
        }
      },
      props: {
        handleDOMEvents: {
          focus: (view) => {
            view.dispatch(
              view.state.tr.setMeta(titleKey, { focused: true }).setMeta('addToHistory', false),
            )
            return false
          },
          blur: (view) => {
            view.dispatch(
              view.state.tr.setMeta(titleKey, { focused: false }).setMeta('addToHistory', false),
            )
            return false
          },
        },
        decorations(state) {
          const data = titleKey.getState(state)
          const title = state.doc.firstChild
          if (
            !title ||
            title.type.name !== 'heading' ||
            title.attrs.level !== 1 ||
            title.content.size === 0 ||
            !data ||
            (!data.metadata.displayTitle && !data.metadata.lang)
          )
            return null
          const shown = noteTitlePresentation(title.textContent, data.metadata)
          // A clean H1 remains native editable text; language is only a widget.
          if (shown.text === title.textContent && shown.language) {
            return DecorationSet.create(state.doc, [
              Decoration.node(0, title.nodeSize, {
                'aria-label': `${shown.text}，${shown.language}`,
              }),
              Decoration.widget(title.nodeSize - 1, () => languageBadge(shown.language!), {
                side: 1,
                ignoreSelection: true,
                key: `language:${shown.language}`,
              }),
            ])
          }
          if (data.focused && state.selection.from <= title.nodeSize - 1) return null
          return DecorationSet.create(state.doc, [
            Decoration.inline(1, title.nodeSize - 1, {
              style: 'font-size:0;opacity:0;',
              'aria-hidden': 'true',
            }),
            Decoration.widget(
              1,
              (view) => {
                const label = document.createElement('span')
                label.className = 'reflect-title-presentation'
                label.contentEditable = 'false'
                label.setAttribute('role', 'button')
                label.setAttribute(
                  'aria-label',
                  shown.language ? `${shown.text}，${shown.language}` : shown.text,
                )
                label.title = 'Edit title'
                label.tabIndex = 0
                label.append(document.createTextNode(shown.text))
                if (shown.language) {
                  label.append(languageBadge(shown.language))
                }
                const edit = (event: Event) => {
                  event.preventDefault()
                  view.dispatch(
                    view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(1))),
                  )
                  view.focus()
                }
                label.addEventListener('mousedown', edit)
                label.addEventListener('keydown', (event) => {
                  if (event.key === 'Enter' || event.key === ' ') edit(event)
                })
                return label
              },
              { side: -1, ignoreSelection: true, key: JSON.stringify(shown) },
            ),
          ])
        },
      },
    }),
  )
}

/** H1 presentation is a decoration; focusing it reveals the unchanged editable title. */
export function NoteTitlePresentationBridge({
  metadata,
}: {
  metadata?: NoteTitleMetadata | undefined
}): null {
  const editor = useEditor()
  const [extension] = useState(() => defineTitlePresentation(metadata ?? {}))
  useExtension(extension)
  useEffect(
    () =>
      whenEditorMounted(editor, () => {
        editor.view.dispatch(
          editor.state.tr
            .setMeta(titleKey, { metadata: metadata ?? {} })
            .setMeta('addToHistory', false),
        )
      }),
    [editor, metadata],
  )
  return null
}
