import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useEffect, type ReactElement } from 'react'
import { setBridge } from '@reflect/core'
import { PaletteProvider } from '@/components/command-palette/palette-provider.tsx'
import { queryClient } from '@/lib/query-client.ts'
import { RouterProvider, useRouter } from '@/routing/router.tsx'
import '@/test-utils/locator.ts'
import { RouteContent } from './route-content.tsx'

/**
 * A followed heading link through the real router, note view, and editor:
 * the arriving note puts the caret in the heading the link points at.
 */

vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  isLocalOnlyPath: () => localOnly,
  isLocalOnlyReadOnlyPath: () => localOnly && !editableLocal,
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
  ...Array.from({ length: 40 }, (_, index) => `Filler paragraph ${index + 1}.\n`),
  '### [C2] The canonical demonstration used a random anchor',
  '',
  'The wheel-of-fortune study.',
].join('\n')

let files: Record<string, string>
let localOnly: boolean
let editableLocal: boolean

beforeEach(() => {
  localOnly = false
  editableLocal = false
  files = { 'wiki/Anchoring.md': ENTRY }
  setBridge({
    invoke: async (command, args) => {
      if (command === 'note_read') return files[String(args.path)]
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

/** Follows a heading link once mounted, the way a wiki-link click does. */
function FollowLink({ fragment }: { fragment: string }): ReactElement | null {
  const { navigate } = useRouter()
  useEffect(() => {
    navigate({ kind: 'note', path: 'wiki/Anchoring.md' }, { revealHeading: fragment })
  }, [navigate, fragment])
  return null
}

function renderFollowing(fragment: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider initialRoute={{ kind: 'today' }}>
        <PaletteProvider>
          <div style={{ height: '400px', display: 'flex', flexDirection: 'column' }}>
            <RouteContent />
          </div>
          <FollowLink fragment={fragment} />
        </PaletteProvider>
      </RouterProvider>
    </QueryClientProvider>,
  )
}

/** The heading element holding the caret, if any. */
function caretHeading(): Element | null {
  const anchor = window.getSelection()?.anchorNode ?? null
  const element = anchor instanceof Element ? anchor : (anchor?.parentElement ?? null)
  return element?.closest('h1, h2, h3, h4, h5, h6') ?? null
}

it('puts the caret in the claim a ^cN link names', async () => {
  const view = await renderFollowing('^c2')

  await expect.element(page.getByText('The wheel-of-fortune study.')).toBeInTheDocument()
  await vi.waitFor(() => expect(caretHeading()?.textContent).toContain('[C2] The canonical'))
  await view.unmount()
})

it('puts the caret in a heading named by its text', async () => {
  const view = await renderFollowing('claims')

  await expect.element(page.getByText('The wheel-of-fortune study.')).toBeInTheDocument()
  await vi.waitFor(() => expect(caretHeading()?.textContent).toBe('Claims'))
  await view.unmount()
})

it('puts the caret in a repeated heading named by its numbered slug', async () => {
  files['wiki/Anchoring.md'] = [
    '# Anchoring',
    '',
    '## Next steps',
    '',
    ...Array.from({ length: 40 }, (_, index) => `Filler paragraph ${index + 1}.\n`),
    '## Next steps',
    '',
    'The second plan.',
  ].join('\n')
  const view = await renderFollowing('next-steps-1')

  await expect.element(page.getByText('The second plan.')).toBeInTheDocument()
  await vi.waitFor(() => {
    const repeats = [...document.querySelectorAll('h2')].filter(
      (heading) => heading.textContent === 'Next steps',
    )
    expect(repeats).toHaveLength(2)
    expect(caretHeading()).toBe(repeats[1])
  })
  await view.unmount()
})

it('scrolls to a heading in the same note from a [[#Heading]] link', async () => {
  files['wiki/Anchoring.md'] = [
    '# Anchoring',
    '',
    'See [[#Evidence]] below.',
    '',
    ...Array.from({ length: 40 }, (_, index) => `Filler paragraph ${index + 1}.\n`),
    '## Evidence',
    '',
    'The wheel-of-fortune study.',
  ].join('\n')
  const view = await renderFollowing('anchoring')

  await page.getByTestId('wikilink').first().click()

  await vi.waitFor(() => expect(caretHeading()?.textContent).toBe('Evidence'))
  await view.unmount()
})

it('reveals a claim after an editable local-only editor mounts', async () => {
  localOnly = true
  editableLocal = true
  const view = await renderFollowing('^c2')

  await expect.element(page.getByText('The wheel-of-fortune study.')).toBeInTheDocument()
  await vi.waitFor(() => expect(caretHeading()?.textContent).toContain('[C2] The canonical'))
  expect(document.querySelector('[contenteditable="true"]')).not.toBeNull()
  await view.unmount()
})

it('reveals a claim in a local-only read-only preview', async () => {
  localOnly = true
  const view = await renderFollowing('^c2')

  await expect.element(page.getByText('The wheel-of-fortune study.')).toBeInTheDocument()
  await vi.waitFor(() =>
    expect(document.activeElement?.textContent).toContain('[C2] The canonical'),
  )
  expect(document.querySelector('[contenteditable="true"]')).toBeNull()
  expect(document.activeElement?.getBoundingClientRect().top).toBeLessThan(window.innerHeight)
  await view.unmount()
})

it('reveals a repeated heading by its numbered slug in a read-only preview', async () => {
  localOnly = true
  files['wiki/Anchoring.md'] = '# Anchoring\n\n## Next steps\n\nFirst.\n\n## Next steps\n\nSecond.'
  const view = await renderFollowing('next-steps-1')

  await expect.element(page.getByText('Second.')).toBeInTheDocument()
  await vi.waitFor(() => {
    const headings = document.querySelectorAll('h2')
    expect(document.activeElement).toBe(headings[1])
  })
  await view.unmount()
})

it('follows a same-note heading link in a read-only preview', async () => {
  localOnly = true
  files['wiki/Anchoring.md'] = '# Anchoring\n\nSee [[#Evidence]].\n\n## Evidence\n\nStudy.'
  const view = await renderFollowing('anchoring')

  await page.getByTestId('wikilink').first().click()

  await vi.waitFor(() => expect(document.activeElement?.textContent).toBe('Evidence'))
  await view.unmount()
})
