import type { LinkPreviewResolver } from '@meowdown/core'
import type { EditorProps } from '@meowdown/react'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { EmbedMediaService } from '@reflect/core'
import { createTestCoreServices, type TestCoreServices } from '@reflect/core/testing'
import { queryClient } from '@/lib/query-client.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { NoteEditor } from './note-editor.tsx'

/**
 * The props each render handed to Meowdown's editor.
 */
const editorProps = vi.hoisted((): EditorProps[] => [])
vi.mock('@meowdown/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@meowdown/react')>()),
  MarkdownEditor: (props: EditorProps) => {
    editorProps.push(props)
    return null
  },
}))

const X_URL = 'https://x.com/jack/status/20'
const YOUTUBE_URL = 'https://youtu.be/aqz-KE-bpKQ'

/**
 * A host resolver that passes remote sources through, like the note pane's.
 */
const hostResolver = vi.fn((src: string) =>
  /^https?:/i.test(src) ? src : `reflect-asset://g/${src}`,
)
const resolveLinkPreview: LinkPreviewResolver = vi.fn(async () => undefined)

let app: TestCoreServices
/**
 * The X post archive reads and YouTube lookups behind the editor's resolvers.
 */
let loadXPost: MockInstance<EmbedMediaService['loadXPost']>
let resolveYouTubeVideo: MockInstance<EmbedMediaService['resolveYouTubeVideo']>

function lastProps(): EditorProps {
  const props = editorProps.at(-1)
  if (props === undefined) throw new Error('the editor never rendered')
  return props
}

function editor(privateNote: boolean) {
  return (
    <NoteEditor
      privateNote={privateNote}
      initialContent=""
      resolveImageUrl={hostResolver}
      resolveLinkPreview={resolveLinkPreview}
    />
  )
}

beforeEach(() => {
  editorProps.length = 0
  vi.clearAllMocks()
  app = createTestCoreServices()
  loadXPost = vi.spyOn(app.embedMedia, 'loadXPost').mockResolvedValue(null)
  resolveYouTubeVideo = vi.spyOn(app.embedMedia, 'resolveYouTubeVideo').mockResolvedValue(undefined)
})

afterEach(() => {
  // The X post resolver reads the shared client.
  queryClient.clear()
})

// The policy every host gets from the one required prop (the DOM behavior is
// covered in note-editor.test.tsx; this pins the wiring).
describe('NoteEditor privateNote wiring', () => {
  it('wires no-op embed resolvers, graph-only images, no link preview, and no auto-embed', async () => {
    await renderInApp(editor(true), { app })
    const props = lastProps()

    expect(props.remoteMedia).toBe(false)
    expect(props.embedPaste).toBe(false)
    expect(props.resolveLinkPreview).toBeUndefined()
    expect(await props.resolveXPost?.(X_URL)).toBeUndefined()
    expect(await props.resolveYouTubeVideo?.(YOUTUBE_URL)).toBeUndefined()
    expect(loadXPost).not.toHaveBeenCalled()
    expect(resolveYouTubeVideo).not.toHaveBeenCalled()
    expect(props.resolveImageUrl?.('https://example.com/a.png')).toBeUndefined()
    expect(props.resolveImageUrl?.('//cdn.example.com/a.png')).toBeUndefined()
    expect(hostResolver).not.toHaveBeenCalled()
    expect(props.resolveImageUrl?.('assets/a.png')).toBe('reflect-asset://g/assets/a.png')
  })

  it('wires the network back in for an ordinary note', async () => {
    await renderInApp(editor(false), { app })
    const props = lastProps()

    expect(props.remoteMedia).toBe(true)
    expect(props.embedPaste).toBe(true)
    expect(props.resolveLinkPreview).toBe(resolveLinkPreview)
    await props.resolveXPost?.(X_URL)
    await props.resolveYouTubeVideo?.(YOUTUBE_URL)
    expect(loadXPost).toHaveBeenCalledWith('20')
    expect(resolveYouTubeVideo).toHaveBeenCalledWith(YOUTUBE_URL)
    expect(props.resolveImageUrl?.('https://example.com/a.png')).toBe('https://example.com/a.png')
  })

  it('switches resolvers held from before a Lock toggle, so a late call stays local', async () => {
    const view = await renderInApp(editor(false), { app })
    const before = lastProps()

    await view.rerender(editor(true))
    const after = lastProps()
    // The same functions: a card mounted before the toggle that resolves
    // late reads the new policy.
    expect(after.resolveXPost).toBe(before.resolveXPost)
    expect(after.resolveImageUrl).toBe(before.resolveImageUrl)
    expect(await before.resolveXPost?.(X_URL)).toBeUndefined()
    expect(await before.resolveYouTubeVideo?.(YOUTUBE_URL)).toBeUndefined()
    expect(before.resolveImageUrl?.('https://example.com/a.png')).toBeUndefined()
    expect(loadXPost).not.toHaveBeenCalled()
    expect(resolveYouTubeVideo).not.toHaveBeenCalled()
    expect(after.remoteMedia).toBe(false)
    expect(after.resolveLinkPreview).toBeUndefined()
  })
})
