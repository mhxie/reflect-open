import type { RefObject } from 'react'
import { renderHook } from 'vitest-browser-react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AiProviderConfig,
  TransformSelectionOptions,
  TransformStreamEvent,
} from '@reflect/core'
import type { NoteEditorHandle } from '@/editor/note-editor.tsx'
import { useEditorAiMenu } from './use-editor-ai-menu.tsx'

const provider = vi.hoisted((): AiProviderConfig => ({
  id: 'test-provider',
  provider: 'openai',
  model: 'gpt-4o-mini',
  keyHint: 'test',
}))
const coreMocks = vi.hoisted(() => ({
  apiKey: vi.fn<() => Promise<string | null>>(),
  transform: vi.fn<(options: TransformSelectionOptions) => AsyncGenerator<TransformStreamEvent>>(
    async function* () {
      yield { type: 'complete', text: 'done' }
    },
  ),
}))
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  aiApiKeyForConfig: coreMocks.apiKey,
  transformSelection: coreMocks.transform,
}))
vi.mock('@/hooks/use-ai-providers.ts', () => ({
  useAiProviders: () => ({ providers: [provider], defaultProvider: provider }),
}))
vi.mock('@/hooks/use-ai-prompts.ts', () => ({
  useAiPrompts: () => ({ prompts: [] }),
}))
vi.mock('@/routing/router.tsx', () => ({
  useRouter: () => ({ navigate: () => {} }),
}))

/** An editor with a non-empty selection, so only privacy can close the menu. */
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

beforeEach(() => {
  vi.clearAllMocks()
  coreMocks.apiKey.mockResolvedValue('test-key')
})

describe('useEditorAiMenu', () => {
  it('offers no cloud AI entry for a private note', async () => {
    const { editorRef, openSelectionMenu } = editorWithSelection()
    const { result } = await renderHook(() =>
      useEditorAiMenu({ path: 'notes/plan.md', privateNote: true, sessionEpoch: 1, editorRef }),
    )
    expect(result.current.onSelectionMenuSearch).toBeUndefined()
    expect(result.current.openMenu()).toBe(false)
    expect(openSelectionMenu).not.toHaveBeenCalled()
  })

  it('offers the menu for a public note (control)', async () => {
    const { editorRef, openSelectionMenu } = editorWithSelection()
    const { result } = await renderHook(() =>
      useEditorAiMenu({ path: 'notes/plan.md', privateNote: false, sessionEpoch: 1, editorRef }),
    )
    expect(result.current.onSelectionMenuSearch).toBeDefined()
    expect(result.current.openMenu()).toBe(true)
    expect(openSelectionMenu).toHaveBeenCalledOnce()
  })

  it('closes the menu as soon as the note turns private', async () => {
    const { editorRef } = editorWithSelection()
    const hook = await renderHook(
      ({ privateNote }: { privateNote: boolean } = { privateNote: false }) =>
        useEditorAiMenu({ path: 'notes/plan.md', privateNote, sessionEpoch: 1, editorRef }),
      { initialProps: { privateNote: false } },
    )
    expect(hook.result.current.onSelectionMenuSearch).toBeDefined()
    await hook.rerender({ privateNote: true })
    expect(hook.result.current.onSelectionMenuSearch).toBeUndefined()
  })

  it('never dispatches a transform when Lock turns private during the keychain lookup', async () => {
    const { editorRef, discardPendingReplacement } = editorWithSelection(true)
    const key = Promise.withResolvers<string | null>()
    coreMocks.apiKey.mockReturnValueOnce(key.promise)
    const hook = await renderHook(
      ({ privateNote }: { privateNote: boolean } = { privateNote: false }) =>
        useEditorAiMenu({ path: 'notes/plan.md', privateNote, sessionEpoch: 1, editorRef }),
      { initialProps: { privateNote: false } },
    )
    const items = await hook.result.current.onSelectionMenuSearch?.('Rewrite', {
      selectedText: 'private selection',
      from: 1,
      to: 18,
    })
    const item = items?.[0]
    if (item === undefined) throw new Error('expected the ad-hoc AI prompt')
    item.onSelect({ selectedText: 'private selection', from: 1, to: 18 })
    expect(coreMocks.apiKey).toHaveBeenCalledOnce()
    expect(coreMocks.transform).not.toHaveBeenCalled()

    await hook.rerender({ privateNote: true })
    expect(discardPendingReplacement).toHaveBeenCalledOnce()
    key.resolve('test-key')
    await key.promise
    await Promise.resolve()
    expect(coreMocks.transform).not.toHaveBeenCalled()

    await hook.rerender({ privateNote: false })
    expect(coreMocks.transform).not.toHaveBeenCalled()
  })

  it('dispatches a transform once the key arrives while the note stays public', async () => {
    const { editorRef } = editorWithSelection(true)
    const key = Promise.withResolvers<string | null>()
    coreMocks.apiKey.mockReturnValueOnce(key.promise)
    const hook = await renderHook(() =>
      useEditorAiMenu({ path: 'notes/plan.md', privateNote: false, sessionEpoch: 1, editorRef }),
    )
    const items = await hook.result.current.onSelectionMenuSearch?.('Rewrite', {
      selectedText: 'public selection',
      from: 1,
      to: 17,
    })
    const item = items?.[0]
    if (item === undefined) throw new Error('expected the ad-hoc AI prompt')
    item.onSelect({ selectedText: 'public selection', from: 1, to: 17 })
    expect(coreMocks.transform).not.toHaveBeenCalled()
    key.resolve('test-key')
    await vi.waitFor(() => expect(coreMocks.transform).toHaveBeenCalledOnce())
  })
})
