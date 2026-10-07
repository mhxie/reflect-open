import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render } from 'vitest-browser-react'
import { page, userEvent } from 'vitest/browser'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setBridge } from '@reflect/core'
import { PaletteProvider } from '@/components/command-palette/palette-provider.tsx'
import { RouteContent } from '@/components/route-content.tsx'
import { queryClient } from '@/lib/query-client.ts'
import { RouterProvider } from '@/routing/router.tsx'
import '@/test-utils/locator.ts'

/**
 * A wiki entry through the real note view and editor: its `anchors` fences
 * fold into numbered references until the caret goes into them.
 */

const openUrlSync = vi.hoisted(() => vi.fn<(url: string) => void>())
vi.mock('@/lib/open-url.ts', () => ({ openUrlSync }))
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  getBacklinksWithContext: async () => ({ contexts: [], nextCursor: null, indexedLinkCount: 0 }),
  relatedNotes: async () => [],
}))
vi.mock('@/providers/graph-provider.tsx', () => ({
  useGraph: () => ({
    graph: { root: '/g', name: 'g', generation: 1 },
    indexing: false,
  }),
}))
vi.mock('@/providers/settings-provider.tsx', () => ({
  useSettings: () => ({
    settings: {
      editorMarkdownSyntax: 'hide',
      wikiLanguages: [{ label: 'English', folder: 'wiki' }],
      allNotesFilterTags: [],
      aiProviders: [],
      defaultAiProviderId: null,
      chatSystemPrompt: '',
      aiPrompts: [],
    },
    updateSettings: async () => {},
    updateSettingsWith: () => {},
  }),
}))

const ENTRY = [
  '# Anchoring',
  '',
  '## Claims',
  '',
  '### [C1] Anchoring pulls estimates toward a start value',
  '',
  'Body of the first claim.',
  '',
  '```anchors',
  '@anchor: arxiv:2501.13956 | valid_at: 2020-01-02',
  '@anchor: doi:10.1037/0033-2909.132.3.354 | valid_at: 2020-01-02 | invalid_at: 2020-02-01',
  '@anchor: url:https://en.wikipedia.org/wiki/Anchoring_effect | valid_at: 2020-01-02 | readwise: 01kk',
  '@pass: reviewer | status: verified | at: 2020-01-03',
  '```',
  '',
  'After the evidence.',
].join('\n')
let entrySource = ENTRY

beforeEach(() => {
  openUrlSync.mockReset()
  entrySource = ENTRY
  setBridge({
    invoke: async (command, args) => {
      if (command === 'note_read')
        return args['path'] === 'wiki/Anchoring.md' ? entrySource : undefined
      if (command === 'db_query') return []
      return null
    },
    listen: async () => () => {},
  })
})

afterEach(async () => {
  await cleanup()
  setBridge(null)
  queryClient.clear()
})

function renderEntry() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider initialRoute={{ kind: 'note', path: 'wiki/Anchoring.md' }}>
        <PaletteProvider>
          <RouteContent />
        </PaletteProvider>
      </RouterProvider>
    </QueryClientProvider>,
  )
}

it('folds evidence into numbered links with dates and reviews behind Details', async () => {
  const view = await renderEntry()

  await expect.element(page.getByText('After the evidence.')).toBeInTheDocument()
  await expect.element(page.getByRole('link', { name: 'arXiv 2501.13956' }).first()).toBeVisible()
  expect(view.container.querySelectorAll('[data-wiki-anchors] .meowdown-reference')).toHaveLength(2)
  expect(view.container.querySelector('pre[data-language="anchors"]')?.checkVisibility()).toBe(
    false,
  )
  await expect
    .element(page.getByText('DOI 10.1037/0033-2909.132.3.354', { exact: true }))
    .not.toBeVisible()
  await expect
    .element(page.getByText('reviewer: verified · 2020-01-03', { exact: true }))
    .not.toBeVisible()
  await page.getByLabelText('Evidence details').click()
  await expect
    .element(page.getByRole('link', { name: 'DOI 10.1037/0033-2909.132.3.354' }))
    .toBeVisible()
  await expect
    .element(page.getByText('reviewer: verified · 2020-01-03', { exact: true }))
    .toBeVisible()
  await expect.element(page.getByText('Readwise', { exact: true })).toBeVisible()
  await view.unmount()
})

it('opens a source in the system browser', async () => {
  const view = await renderEntry()

  await page.getByRole('link', { name: 'arXiv 2501.13956' }).first().click()
  expect(openUrlSync).toHaveBeenCalledWith('https://arxiv.org/abs/2501.13956')

  await page.getByLabelText('Evidence details').click()
  await page.getByText('Readwise', { exact: true }).click()
  expect(openUrlSync).toHaveBeenLastCalledWith('https://read.readwise.io/read/01kk')
  await view.unmount()
})

it('packs matching trailing source links once, retains locators, and reveals them for editing', async () => {
  const suffix = '[Author A, pp1–2](https://example.org/a); [Author B, p3](https://example.org/b).'
  entrySource = [
    '# Entry',
    '',
    `A supported claim. ${suffix}`,
    '',
    '```anchors',
    '@anchor: url:https://example.org/old | valid_at: 2020-01-01 | invalid_at: 2020-02-01',
    '@anchor: url:https://example.org/a | valid_at: 2020-01-01',
    '@anchor: url:https://example.org/b | valid_at: 2020-01-01',
    '@pass: reviewer | status: verified | at: 2020-01-02 | ref: Review Note',
    '```',
    '',
    'After the evidence.',
  ].join('\n')
  const view = await renderEntry()
  await expect.element(page.getByText('After the evidence.')).toBeVisible()
  const folded = (): Element | null =>
    view.container.querySelector('[data-wiki-source-links-folded]')
  expect(folded()).not.toBeNull()
  expect(folded()?.checkVisibility()).toBe(false)
  expect(view.container.querySelector('.ProseMirror')?.textContent).toContain(suffix)
  expect(view.container.querySelectorAll('.meowdown-reference')).toHaveLength(2)
  expect(view.container.querySelector('.wiki-evidence-row > a')?.getAttribute('title')).toContain(
    'Author A, pp1–2',
  )
  await expect.element(page.getByText('Check evidence', { exact: true })).not.toBeInTheDocument()
  await page.getByLabelText('Evidence details').click()
  await expect.element(page.getByRole('link', { name: 'Author A, pp1–2' }).last()).toBeVisible()
  await expect
    .element(page.getByText('reviewer: verified · 2020-01-02 · Review Note'))
    .toBeVisible()
  await page.getByText('A supported claim.', { exact: false }).click({ position: { x: 5, y: 8 } })
  expect(folded()).toBeNull()
  await page.getByText('After the evidence.').click()
  expect(folded()?.checkVisibility()).toBe(false)
  await view.unmount()
})

it('shows the raw fence for editing once the caret goes into it', async () => {
  const view = await renderEntry()

  await page.getByLabelText('Evidence details').click()
  await page.getByRole('button', { name: 'Edit metadata' }).click()

  await expect.element(page.getByText(/@anchor: arxiv:2501\.13956/)).toBeVisible()
  expect(view.container.querySelector('[data-wiki-anchors]')).toBeNull()
  await view.unmount()
})

it('opens the right block from Edit after text is added above it', async () => {
  const view = await renderEntry()
  await page.getByText('Body of the first claim.').click()

  await userEvent.keyboard(' More detail.')
  await expect.element(page.getByText('Body of the first claim. More detail.')).toBeVisible()
  await page.getByLabelText('Evidence details').click()
  await page.getByRole('button', { name: 'Edit metadata' }).click()

  await expect.element(page.getByText(/@anchor: arxiv:2501\.13956/)).toBeVisible()
  await view.unmount()
})

it('enters the folded block with the arrow keys instead of skipping it', async () => {
  const view = await renderEntry()
  // The click lands past the line's end, where the caret stays.
  await page.getByText('Body of the first claim.').click()

  await userEvent.keyboard('{ArrowRight}')
  await expect.element(page.getByText(/@anchor: arxiv:2501\.13956/)).toBeVisible()

  await page.getByText('After the evidence.').click({ position: { x: 1, y: 8 } })
  await expect.element(page.getByRole('link', { name: 'arXiv 2501.13956' }).first()).toBeVisible()
  await userEvent.keyboard('{ArrowLeft}')
  await expect.element(page.getByText(/@pass: reviewer/)).toBeVisible()
  await view.unmount()
})

it('folds legacy citations while preserving source and keyboard protection', async () => {
  const citation = '@cite: [[Related#^c2]] | valid_at: 2020-01-02'
  entrySource = ['# Anchoring', '', 'Claim before.', '', citation, '', 'After the citation.'].join(
    '\n',
  )
  const view = await renderEntry()
  await expect.element(page.getByRole('button', { name: 'Open Related#^c2' }).first()).toBeVisible()
  const source = (): Element | null => view.container.querySelector('p[data-wiki-anchors-folded]')
  expect(source()?.querySelector('.md-wikilink-view-content')?.textContent).toBe('[[Related#^c2]]')
  expect(source()?.textContent).toContain('| valid_at: 2020-01-02')
  await page.getByText('Claim before.', { exact: true }).click()
  await userEvent.keyboard('{Delete}')
  expect(source()).toBeNull()
  await expect.element(page.getByText(/@cite:/).first()).toBeVisible()
  await expect.element(page.getByText('Claim before.', { exact: true })).toBeVisible()
  await page.getByText('After the citation.', { exact: true }).click({ position: { x: 1, y: 8 } })
  expect(source()?.querySelector('.md-wikilink-view-content')?.textContent).toBe('[[Related#^c2]]')
  expect(source()?.textContent).toContain('| valid_at: 2020-01-02')
  await userEvent.keyboard('{Backspace}')
  await expect.element(page.getByText(/@cite:/).first()).toBeVisible()
  await expect.element(page.getByText('After the citation.', { exact: true })).toBeVisible()
  await view.unmount()
})

it('keeps flagged reviews and unparsed evidence visible in the collapsed row', async () => {
  entrySource = ENTRY.replace('status: verified', 'status: flagged').replace(
    '```\n\nAfter',
    'Do not hide this qualification.\n```\n\nAfter',
  )
  const view = await renderEntry()
  await expect.element(page.getByText('Flagged review', { exact: true })).toBeVisible()
  await expect.element(page.getByText('Check evidence', { exact: true })).toBeVisible()
  await page.getByLabelText('Evidence details').click()
  await expect
    .element(page.getByText('Do not hide this qualification.', { exact: true }))
    .toBeVisible()
  await view.unmount()
})

it('renders inline references in the note editor and exposes source through the keyboard', async () => {
  entrySource =
    '# Anchoring\n\nClaim [[Related#^c2|ref]]<!-- {"metadata":{"citation":{"valid_at":"2020-01-02"}}} -->\n\nAfter.'
  const view = await renderEntry()
  const reference = page.getByTestId('wikilink').first()
  await expect.element(reference).toHaveClass(/meowdown-reference/)
  reference.element().focus()
  await userEvent.keyboard('{Alt>}{Enter}{/Alt}')
  await expect.element(reference).not.toBeVisible()
  await expect.element(page.getByText(/"valid_at":"2020-01-02"/)).toBeVisible()
  await userEvent.keyboard('{Escape}')
  await expect.element(reference).toBeVisible()
  await view.unmount()
})

it('unfolds the block on Delete or Backspace beside it instead of joining it', async () => {
  const view = await renderEntry()
  // The click lands past the line's end, where the caret stays.
  await page.getByText('Body of the first claim.').click()

  await userEvent.keyboard('{Delete}')

  await expect.element(page.getByText(/@anchor: arxiv:2501\.13956/)).toBeVisible()
  await expect.element(page.getByText('Body of the first claim.', { exact: true })).toBeVisible()

  await page.getByText('After the evidence.').click({ position: { x: 1, y: 8 } })
  await userEvent.keyboard('{Backspace}')

  await expect.element(page.getByText(/@pass: reviewer/)).toBeVisible()
  await expect.element(page.getByText('After the evidence.', { exact: true })).toBeVisible()
  await view.unmount()
})

it('deletes an empty line beside the block instead of entering it', async () => {
  const view = await renderEntry()
  const paragraphs = (): number => view.container.querySelectorAll('.ProseMirror p').length
  const evidence = '@pass: reviewer | status: verified | at: 2020-01-03'

  // An empty line after the block: Backspace removes the line, not evidence.
  await page.getByText('After the evidence.').click({ position: { x: 1, y: 8 } })
  await userEvent.keyboard('{Enter}')
  const withEmptyLine = paragraphs()
  await userEvent.keyboard('{ArrowUp}{Backspace}')
  await vi.waitFor(() => expect(paragraphs()).toBe(withEmptyLine - 1))
  const fence = (): string =>
    view.container.querySelector('pre[data-language="anchors"]')?.textContent ?? ''
  expect(fence()).toContain(evidence)

  // An empty line before the block: Delete removes the line and leaves the
  // evidence its own block (not pulled up into a paragraph).
  // The click lands past the line's end, where the caret stays.
  await page.getByText('Body of the first claim.').click()
  await userEvent.keyboard('{Enter}')
  const beforeBlock = paragraphs()
  await userEvent.keyboard('{Delete}')
  await vi.waitFor(() => expect(paragraphs()).toBe(beforeBlock - 1))
  expect(fence()).toContain('@anchor: arxiv:2501.13956 | valid_at: 2020-01-02')
  await view.unmount()
})
