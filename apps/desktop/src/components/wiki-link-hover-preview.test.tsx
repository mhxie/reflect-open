import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { useEffect, useState, type ReactElement, type ReactNode } from 'react'
import type { WikilinkHoverHit } from '@meowdown/core'
import { createTestCoreServices, createTestNoteFileService } from '@reflect/core/testing'
import { useWikiLinkHoverPreview } from '@/editor/use-wiki-link-hover-preview.tsx'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { WikiLinkHoverPreview } from './wiki-link-hover-preview.tsx'

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

function remoteElements(): Element | null {
  return document.querySelector(
    'img[src^="https:"], img[src^="http:"], iframe, meowdown-embed-x, meowdown-embed-youtube',
  )
}

function hoverHit(target: string): WikilinkHoverHit {
  return { target, from: 0, to: 0, element: document.createElement('span') }
}

/** The hover card's body for `target`, as the editor would render it. */
function HoverCard({ target }: { target: string }): ReactElement {
  const renderCard = useWikiLinkHoverPreview({ dateFormat: 'mdy' })
  const [card, setCard] = useState<ReactNode>(null)
  useEffect(() => {
    void renderCard(hoverHit(target)).then(setCard)
  }, [renderCard, target])
  return <>{card}</>
}

describe('wiki-link hover card over a private target', () => {
  it.each([
    ['a local-only target', 'finance/secure/bank.md', REMOTE_BODY],
    ['a locked target', 'notes/locked.md', `---\nprivate: true\n---\n${REMOTE_BODY}`],
  ])('reaches nothing remote for %s', async (_label, path, source) => {
    const app = createTestCoreServices({
      database: createWasmTestDatabaseService(),
      noteFile: createTestNoteFileService({ files: { [path]: source } }),
    })
    onTestFinished(() => app.database.close())
    vi.spyOn(app.noteLinkResolver, 'resolveWikiTarget').mockResolvedValue({
      kind: 'resolved',
      path,
    })
    const screen = await renderInApp(<HoverCard target="Target" />, {
      core: app,
      graph: { root: '/graph', name: 'g', generation: 7, localOnlyFolders: ['secure'] },
    })

    await expect.element(screen.getByText('Body')).toBeVisible()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(remoteElements()).toBeNull()
    const commands = app.ipc.calls().map((call) => call.command)
    for (const command of REMOTE_COMMANDS) {
      expect(commands).not.toContain(command)
    }
  })

  it('loads no remote image even through a resolver that would pass one', async () => {
    const resolveImageUrl = vi.fn((src: string) => src)
    const screen = await renderInApp(
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
