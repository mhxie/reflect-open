import { render } from 'vitest-browser-react'
import { describe, expect, it, vi } from 'vitest'
import { MarkdownPreview } from './markdown-preview.tsx'

vi.mock('@/providers/graph-provider.tsx', () => ({
  useGraph: () => ({ graph: { root: '/g', name: 'g', generation: 7 } }),
}))

describe('MarkdownPreview wiki-link chips', () => {
  it('labels chips through the host resolver and reports the full target', async () => {
    const onWikiLinkClick = vi.fn()
    const view = await render(
      <MarkdownPreview
        content={'see [[Tim MacCaw // Dad|Dad]] and [[Tim MacCaw // Dad]]'}
        onWikiLinkClick={onWikiLinkClick}
      />,
    )
    const chips = view.getByTestId('wikilink')
    await expect.element(chips.first()).toMatchTextContent(/^Dad$/)
    await expect.element(chips.last()).toMatchTextContent(/^Tim MacCaw$/)
    await chips.first().click()
    expect(onWikiLinkClick).toHaveBeenCalledWith({
      target: 'Tim MacCaw // Dad',
      openInNewWindow: false,
    })
    await view.unmount()
  })
})

describe('MarkdownPreview saved embed snapshots', () => {
  const THUMBNAIL = 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg'
  const showsImage = (container: HTMLElement, src: string): boolean =>
    [...container.querySelectorAll('img')].some((img) => img.getAttribute('src') === src)
  const SNAPSHOT = JSON.stringify({
    snapshot: {
      kind: 'youtube-video',
      data: {
        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        title: 'A video',
        author_name: 'Someone',
        author_url: 'https://www.youtube.com/@someone',
        thumbnail_url: THUMBNAIL,
        thumbnail_width: 480,
        thumbnail_height: 360,
        width: 200,
        height: 113,
      },
    },
  })
  const CONTENT = `![](https://www.youtube.com/watch?v=dQw4w9WgXcQ)<!-- ${SNAPSHOT} -->`

  it('shows embeds as their source URLs when remote embeds are off', async () => {
    const view = await render(
      <MarkdownPreview
        content={`${CONTENT}\n\n![](https://x.com/jack/status/20)\n\n![](https://example.com/a.png)`}
        remoteEmbeds={false}
      />,
    )
    // Meowdown's remoteMedia is off: no card renders, from the snapshot or a
    // resolver, so the thumbnail never loads; nor does the remote image.
    const links = view.getByTestId('embed-link')
    await expect
      .element(links.first())
      .toHaveTextContent('https://www.youtube.com/watch?v=dQw4w9WgXcQ')
    await expect.element(links.last()).toHaveTextContent('https://x.com/jack/status/20')
    expect(view.container.querySelector('[data-meowdown-embed]')).toBeNull()
    expect(showsImage(view.container, THUMBNAIL)).toBe(false)
    expect(view.container.querySelector('img[src^="https:"]')).toBeNull()
    await view.unmount()
  })

  it('renders the snapshot card when remote embeds are on (control)', async () => {
    const view = await render(<MarkdownPreview content={CONTENT} />)
    await vi.waitFor(() => {
      expect(showsImage(view.container, THUMBNAIL)).toBe(true)
    })
    await view.unmount()
  })
})
