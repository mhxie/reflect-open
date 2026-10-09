import { render } from 'vitest-browser-react'
import { describe, expect, it, vi } from 'vitest'
import { MarkdownPreview } from './markdown-preview.tsx'

// One graph object, as the app holds it, so render identities stay stable.
const graphState = vi.hoisted(() => ({ graph: { root: '/g', name: 'g', generation: 7 } }))
vi.mock('@/providers/graph-provider.tsx', () => ({ useGraph: () => graphState }))

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

  it('renders inline and legacy citations with the same reference appearance and canonical navigation', async () => {
    const onWikiLinkClick = vi.fn()
    const content = [
      'Claim [[Source#^c2|ref]]<!-- {"metadata":{"citation":{"valid_at":"2020-01-02"}}} --> and [[Topic]].',
      '',
      '@cite: [[Other#^c3]] | valid_at: 2020-01-02',
      '',
      '```anchors',
      '@anchor: arxiv:2501.13956 | valid_at: 2020-01-02',
      '@pass: reviewer | status: verified | at: 2020-01-03',
      '```',
    ].join('\n')
    const view = await render(
      <MarkdownPreview content={content} onWikiLinkClick={onWikiLinkClick} />,
    )
    await vi.waitFor(() =>
      expect(view.container.querySelectorAll('.meowdown-reference')).toHaveLength(3),
    )
    const inline = view.getByTestId('wikilink').first()
    await expect.element(inline).toHaveClass(/meowdown-reference/)
    await expect
      .element(inline)
      .toHaveAttribute('title', 'Source#^c2\nEvidence recorded 2020-01-02')
    await inline.click()
    expect(onWikiLinkClick).toHaveBeenLastCalledWith({
      target: 'Source#^c2',
      openInNewWindow: false,
    })
    await view.getByRole('button', { name: 'Open Other#^c3' }).first().click()
    expect(onWikiLinkClick).toHaveBeenLastCalledWith({
      target: 'Other#^c3',
      openInNewWindow: false,
    })
    await expect.element(view.getByTestId('wikilink').last()).not.toHaveClass(/meowdown-reference/)
    await expect
      .element(view.getByText('reviewer: verified · 2020-01-03', { exact: true }))
      .not.toBeVisible()
    await view.getByLabelText('Evidence details').last().click()
    await expect
      .element(view.getByText('reviewer: verified · 2020-01-03', { exact: true }))
      .toBeVisible()
    expect(view.container.querySelector('[data-language="anchors"]')).toBeNull()
    await view.unmount()
  })

  it('keeps mixed prose and malformed legacy citations visible', async () => {
    const content =
      '@cite: [[Source]] | valid_at: 2020-01-02\nAn important qualification.\n\n@cite: [[Other]] | valid_at: unknown'
    const view = await render(<MarkdownPreview content={content} />)
    expect(view.container.querySelector('[data-wiki-anchors]')).toBeNull()
    expect(view.container.textContent).toContain('An important qualification.')
    expect(view.container.textContent).toContain('valid_at: unknown')
    await view.unmount()
  })

  it('groups matched source links with evidence in previews and updates when the fence changes', async () => {
    const prose = 'A supported claim. [Author, p2](https://example.org/paper).'
    const fence = '```anchors\n@anchor: url:https://example.org/paper | valid_at: 2020-01-02\n```'
    const view = await render(<MarkdownPreview content={`${prose}\n\n${fence}`} />)
    await vi.waitFor(() =>
      expect(view.container.querySelectorAll('.meowdown-reference')).toHaveLength(1),
    )
    expect(view.container.querySelector('p')?.textContent).toBe('A supported claim.')
    await expect
      .element(view.getByRole('link', { name: 'Author, p2' }).first())
      .toHaveAttribute('href', 'https://example.org/paper')
    await view.getByLabelText('Evidence details').click()
    await expect.element(view.getByRole('link', { name: 'Author, p2' }).last()).toBeVisible()
    await view.rerender(
      <MarkdownPreview
        content={`${prose}\n\n${fence.replace('example.org/paper', 'example.org/other')}`}
      />,
    )
    await vi.waitFor(() =>
      expect(view.container.querySelector('p')?.textContent).toContain('Author, p2'),
    )
    await view.unmount()
  })

  it('renumbers a distant citation when an earlier one changes', async () => {
    const article = (first: string): string =>
      [
        '# Example',
        '',
        `One <!-- claim:c1 -->first [ref][${first}]<!-- /claim:c1 -->.`,
        '',
        'Between.',
        '',
        'Later <!-- claim:c2 -->claim [ref][two]<!-- /claim:c2 -->.',
        '',
        '## Evidence',
        '',
        '[one]: https://example.org/one "Study one"',
        '[two]: https://example.org/two "Study two"',
      ].join('\n')
    const later = (): string | undefined =>
      [...view.container.querySelectorAll('p')]
        .find((paragraph) => paragraph.textContent.startsWith('Later'))
        ?.querySelector('.wiki-article-reference')?.textContent
    const view = await render(<MarkdownPreview content={article('one')} />)
    await vi.waitFor(() => expect(later()).toBe('[2]'))
    // Now the earlier claim cites `two` first, so the later citation is [1].
    await view.rerender(<MarkdownPreview content={article('two')} />)
    await vi.waitFor(() => expect(later()).toBe('[1]'))
    await view.unmount()
  })

  it('keeps passive evidence previews free of focusable controls', async () => {
    const view = await render(
      <MarkdownPreview
        interactive={false}
        content={
          '@cite: [[Source]] | valid_at: 2020-01-02\n\n```anchors\n@anchor: arxiv:2501.13956 | valid_at: 2020-01-02\n```'
        }
      />,
    )
    await vi.waitFor(() =>
      expect(view.container.querySelectorAll('.meowdown-reference')).toHaveLength(2),
    )
    expect(view.container.querySelector('a, button, summary, [tabindex]')).toBeNull()
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
