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
 * fold into source chips until the caret goes into them.
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

beforeEach(() => {
  openUrlSync.mockReset()
  setBridge({
    invoke: async (command, args) => {
      if (command === 'note_read') return args['path'] === 'wiki/Anchoring.md' ? ENTRY : undefined
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

it('folds the fence into source links and review badges', async () => {
  const view = await renderEntry()

  await expect.element(page.getByText('After the evidence.')).toBeInTheDocument()
  await expect.element(page.getByText('arXiv 2501.13956 ↗')).toBeVisible()
  await expect.element(page.getByText('en.wikipedia.org ↗')).toBeVisible()
  await expect.element(page.getByText('Readwise', { exact: true })).toBeVisible()
  await expect.element(page.getByLabelText('reviewer verified 2020-01-03')).toBeVisible()
  // The raw marker lines are folded away while the caret is elsewhere.
  expect(
    page
      .getByText(/@anchor: arxiv/)
      .query()
      ?.checkVisibility() ?? false,
  ).toBe(false)
  // An invalidated anchor stays, struck through.
  await expect
    .element(page.getByLabelText('doi:10.1037/0033-2909.132.3.354 (lapsed)'))
    .toHaveClass(/line-through/)
  await view.unmount()
})

it('opens a source in the system browser', async () => {
  const view = await renderEntry()

  await page.getByText('arXiv 2501.13956 ↗').click()
  expect(openUrlSync).toHaveBeenCalledWith('https://arxiv.org/abs/2501.13956')

  await page.getByText('Readwise', { exact: true }).click()
  expect(openUrlSync).toHaveBeenLastCalledWith('https://read.readwise.io/read/01kk')
  await view.unmount()
})

it('shows the raw fence for editing once the caret goes into it', async () => {
  const view = await renderEntry()

  await page.getByRole('button', { name: 'Edit sources' }).click()

  await expect.element(page.getByText(/@anchor: arxiv:2501\.13956/)).toBeVisible()
  expect(page.getByText('arXiv 2501.13956 ↗').query()).toBeNull()
  await view.unmount()
})

it('opens the right block from Edit after text is added above it', async () => {
  const view = await renderEntry()
  await page.getByText('Body of the first claim.').click()

  await userEvent.keyboard(' More detail.')
  await expect.element(page.getByText('Body of the first claim. More detail.')).toBeVisible()
  await page.getByRole('button', { name: 'Edit sources' }).click()

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
  await expect.element(page.getByText('arXiv 2501.13956 ↗')).toBeVisible()
  await userEvent.keyboard('{ArrowLeft}')
  await expect.element(page.getByText(/@pass: reviewer/)).toBeVisible()
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
