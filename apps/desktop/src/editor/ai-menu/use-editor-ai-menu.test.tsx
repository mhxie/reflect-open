import type { RefObject } from 'react'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { AiProviderConfig } from '@reflect/core'
import { createTestCoreServices } from '@reflect/core/testing'
import type { NoteEditorHandle } from '@/editor/note-editor.tsx'
import { toast } from '@/components/ui/toast.tsx'
import { renderHookInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { useEditorAiMenu } from './use-editor-ai-menu.tsx'

const PROVIDER: AiProviderConfig = {
  id: 'test-provider',
  provider: 'openai',
  model: 'gpt-4o-mini',
  keyHint: 'test',
}

/**
 * An editor with a non-empty selection, so only privacy can close the menu.
 */
function editorWithSelection(stagesReplacement = false): {
  editorRef: RefObject<NoteEditorHandle | null>
  openSelectionMenu: () => void
  discardPendingReplacement: () => void
} {
  const openSelectionMenu = vi.fn()
  const discardPendingReplacement = vi.fn()
  const handle: NoteEditorHandle = {
    getMarkdown: () => 'selected words',
    setMarkdown: () => {},
    insertMarkdown: () => {},
    focus: () => {},
    setSelection: () => {},
    getSelectedText: () => 'selected words',
    openSelectionMenu,
    startPendingReplacement: () => stagesReplacement,
    appendPendingReplacementText: () => {},
    acceptPendingReplacement: () => {},
    discardPendingReplacement,
    findNext: () => {},
    findPrevious: () => {},
    revealHeading: () => false,
  }
  return { editorRef: { current: handle }, openSelectionMenu, discardPendingReplacement }
}

/**
 * Core services whose keychain read for the provider waits on `key`, and the
 * spy that sees every provider call (a model built for the transform).
 */
function appWithKey(key: Promise<string | null>) {
  const app = createTestCoreServices({ database: createWasmTestDatabaseService() })
  onTestFinished(() => app.database.close())
  const read = vi.spyOn(app.aiCredentials, 'read').mockReturnValueOnce(key)
  const create = vi.spyOn(app.languageModel, 'create')
  return { app, read, create }
}

describe('useEditorAiMenu', () => {
  it('offers no cloud AI entry for a private note and says why when asked', async () => {
    const add = vi.spyOn(toast, 'add')
    const { editorRef, openSelectionMenu } = editorWithSelection()
    const { result } = await renderHookInApp(
      () => {
        return useEditorAiMenu({
          path: 'notes/plan.md',
          privateNote: true,
          sessionEpoch: 1,
          editorRef,
        })
      },
      { settings: { aiProviders: [PROVIDER] } },
    )
    expect(result.current.onSelectionMenuSearch).toBeUndefined()
    expect(result.current.openMenu()).toBe(true)
    expect(openSelectionMenu).not.toHaveBeenCalled()
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ title: 'AI is off for this note' }))
    add.mockRestore()
  })

  it('offers the menu for a public note (control)', async () => {
    const { editorRef, openSelectionMenu } = editorWithSelection()
    const { result } = await renderHookInApp(
      () => {
        return useEditorAiMenu({
          path: 'notes/plan.md',
          privateNote: false,
          sessionEpoch: 1,
          editorRef,
        })
      },
      { settings: { aiProviders: [PROVIDER] } },
    )
    expect(result.current.onSelectionMenuSearch).toBeDefined()
    expect(result.current.openMenu()).toBe(true)
    expect(openSelectionMenu).toHaveBeenCalledOnce()
  })

  it('closes the menu as soon as the note turns private', async () => {
    const { editorRef } = editorWithSelection()
    const hook = await renderHookInApp(
      ({ privateNote }: { privateNote: boolean } = { privateNote: false }) => {
        return useEditorAiMenu({ path: 'notes/plan.md', privateNote, sessionEpoch: 1, editorRef })
      },
      { settings: { aiProviders: [PROVIDER] }, initialProps: { privateNote: false } },
    )
    expect(hook.result.current.onSelectionMenuSearch).toBeDefined()
    await hook.rerender({ privateNote: true })
    expect(hook.result.current.onSelectionMenuSearch).toBeUndefined()
  })

  it('never calls the provider when Lock turns private during the keychain lookup', async () => {
    const { editorRef, discardPendingReplacement } = editorWithSelection(true)
    const key = Promise.withResolvers<string | null>()
    const { app, read, create } = appWithKey(key.promise)
    const hook = await renderHookInApp(
      ({ privateNote }: { privateNote: boolean } = { privateNote: false }) => {
        return useEditorAiMenu({ path: 'notes/plan.md', privateNote, sessionEpoch: 1, editorRef })
      },
      { core: app, settings: { aiProviders: [PROVIDER] }, initialProps: { privateNote: false } },
    )
    const items = await hook.result.current.onSelectionMenuSearch?.('Rewrite', {
      selectedText: 'private selection',
      from: 1,
      to: 18,
    })
    const item = items?.find((candidate) => candidate.id === 'ad-hoc-query')
    if (item === undefined) throw new Error('expected the ad-hoc AI prompt')
    item.onSelect({ selectedText: 'private selection', from: 1, to: 18 })
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce())
    expect(create).not.toHaveBeenCalled()

    await hook.rerender({ privateNote: true })
    expect(discardPendingReplacement).toHaveBeenCalledOnce()
    key.resolve('test-key')
    await key.promise
    await Promise.resolve()
    expect(create).not.toHaveBeenCalled()

    await hook.rerender({ privateNote: false })
    expect(create).not.toHaveBeenCalled()
  })

  it('calls the provider once the key arrives while the note stays public', async () => {
    const { editorRef } = editorWithSelection(true)
    const key = Promise.withResolvers<string | null>()
    const { app, read, create } = appWithKey(key.promise)
    const hook = await renderHookInApp(
      () => {
        return useEditorAiMenu({
          path: 'notes/plan.md',
          privateNote: false,
          sessionEpoch: 1,
          editorRef,
        })
      },
      { core: app, settings: { aiProviders: [PROVIDER] } },
    )
    const items = await hook.result.current.onSelectionMenuSearch?.('Rewrite', {
      selectedText: 'public selection',
      from: 1,
      to: 17,
    })
    const item = items?.find((candidate) => candidate.id === 'ad-hoc-query')
    if (item === undefined) throw new Error('expected the ad-hoc AI prompt')
    item.onSelect({ selectedText: 'public selection', from: 1, to: 17 })
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce())
    expect(create).not.toHaveBeenCalled()
    key.resolve('test-key')
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce())
  })
})
