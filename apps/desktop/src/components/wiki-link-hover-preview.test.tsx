import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, renderHook } from 'vitest-browser-react'
import type { WikilinkHoverHit } from '@meowdown/core'
import { setBridge } from '@reflect/core'
import { useWikiLinkHoverPreview } from '@/editor/use-wiki-link-hover-preview.tsx'
import { queryClient } from '@/lib/query-client.ts'
import { WikiLinkHoverPreview } from './wiki-link-hover-preview.tsx'

vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tauri-apps/api/core')>()),
  convertFileSrc: (filePath: string) => `reflect-asset://${filePath}`,
}))
const mocks = vi.hoisted(() => ({
  resolveExistingWikiTarget: vi.fn(),
  readExistingNoteSource: vi.fn(),
}))
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  resolveExistingWikiTarget: mocks.resolveExistingWikiTarget,
  // The graph's local-only folders are `secure`.
  isLocalOnlyPath: (path: string) => path.split('/').slice(0, -1).includes('secure'),
}))
vi.mock('@/lib/read-existing-note-source.ts', () => ({
  readExistingNoteSource: mocks.readExistingNoteSource,
}))
vi.mock('@/providers/graph-provider.tsx', () => ({
  useGraph: () => ({ graph: { root: '/graph', name: 'g', generation: 7 } }),
}))

const YOUTUBE_URL = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'
// A saved card whose poster would load from the network if it rendered.
const SAVED_YOUTUBE = `![](${YOUTUBE_URL})<!-- ${JSON.stringify({
  snapshot: {
    kind: 'youtube-video',
    data: {
      url: YOUTUBE_URL,
      title: 'Big Buck Bunny',
      author_name: 'Blender',
      author_url: 'https://www.youtube.com/@Blender',
      thumbnail_url: 'https://i.ytimg.com/vi/aqz-KE-bpKQ/hqdefault.jpg',
      thumbnail_width: 480,
      thumbnail_height: 360,
      width: 200,
      height: 113,
    },
  },
})} -->`
const REMOTE_BODY = [
  'Body',
  '![](https://x.com/u/status/1)',
  SAVED_YOUTUBE,
  '![chart](https://example.com/chart.png)',
].join('\n\n')
/** What reaches the network, or writes the X archive, on a note's behalf. */
const REMOTE_COMMANDS = [
  'x_archive_resolve',
  'x_syndication_fetch',
  'x_archive_write',
  'capture_oembed_fetch',
]

let commands: string[]

function remoteElements(): Element | null {
  return document.querySelector(
    'img[src^="https:"], img[src^="http:"], iframe, meowdown-embed-x, meowdown-embed-youtube',
  )
}

function hoverHit(target: string): WikilinkHoverHit {
  return { target, from: 0, to: 0, element: document.createElement('span') }
}

beforeEach(() => {
  commands = []
  setBridge({
    invoke: async (command) => {
      commands.push(command)
      return null
    },
    listen: async () => () => {},
  })
})

afterEach(() => {
  setBridge(null)
  queryClient.clear()
  vi.clearAllMocks()
})

describe('wiki-link hover card over a private target', () => {
  it.each([
    ['a local-only target', 'finance/secure/bank.md', REMOTE_BODY],
    ['a locked target', 'notes/locked.md', `---\nprivate: true\n---\n${REMOTE_BODY}`],
  ])('reaches nothing remote for %s', async (_label, path, source) => {
    mocks.resolveExistingWikiTarget.mockResolvedValue({ kind: 'resolved', path })
    mocks.readExistingNoteSource.mockResolvedValue(source)
    const { result } = await renderHook(() =>
      useWikiLinkHoverPreview({ generation: 7, graphKey: '/graph', dateFormat: 'mdy' }),
    )

    const screen = await render(<>{await result.current(hoverHit('Target'))}</>)
    await expect.element(screen.getByText('Body')).toBeVisible()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(remoteElements()).toBeNull()
    for (const command of REMOTE_COMMANDS) {
      expect(commands).not.toContain(command)
    }
  })

  it('loads no remote image even through a resolver that would pass one', async () => {
    const resolveImageUrl = vi.fn((src: string) => src)
    const screen = await render(
      <WikiLinkHoverPreview
        path="notes/locked.md"
        markdown={REMOTE_BODY}
        privateNote
        dateFormat="mdy"
        resolveImageUrl={resolveImageUrl}
      />,
    )
    await expect.element(screen.getByText('Body')).toBeVisible()
    expect(remoteElements()).toBeNull()
    expect(resolveImageUrl).not.toHaveBeenCalled()
  })
})
