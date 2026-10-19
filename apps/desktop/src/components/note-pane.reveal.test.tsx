import { page } from 'vitest/browser'
import { expect, it, onTestFinished, vi } from 'vitest'
import { useEffect, type ReactElement } from 'react'
import { createTestCoreServices, createTestNoteFileService } from '@reflect/core/testing'
import { PaletteProvider } from '@/components/command-palette/palette-provider.tsx'
import { useRouter } from '@/routing/router.tsx'
import '@/test-utils/locator.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { RouteContent } from './route-content.tsx'

/**
 * A followed heading link through the real router, note view, and editor:
 * the arriving note puts the caret in the heading the link points at.
 */

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

/** Follows a heading link once mounted, the way a wiki-link click does. */
function FollowLink({ fragment }: { fragment: string }): ReactElement | null {
  const { navigate } = useRouter()
  useEffect(() => {
    navigate({ kind: 'note', path: 'wiki/Anchoring.md' }, { revealHeading: fragment })
  }, [navigate, fragment])
  return null
}

/**
 * Open the entry (`source`, the claim entry by default) through a heading
 * link to `fragment`. `localOnly` puts its `wiki` folder among the graph's
 * local-only folders: `'editable'` edits in place, `'read-only'` previews.
 */
async function renderFollowing(
  fragment: string,
  options?: { source?: string; localOnly?: 'editable' | 'read-only' },
) {
  const app = createTestCoreServices({
    database: createWasmTestDatabaseService(),
    noteFile: createTestNoteFileService({
      files: { 'wiki/Anchoring.md': options?.source ?? ENTRY },
    }),
  })
  onTestFinished(() => app.database.close())
  const localOnly = options?.localOnly
  return await renderInApp(
    <PaletteProvider>
      <div style={{ height: '400px', display: 'flex', flexDirection: 'column' }}>
        <RouteContent />
      </div>
      <FollowLink fragment={fragment} />
    </PaletteProvider>,
    {
      app,
      graph: {
        root: '/g',
        name: 'g',
        generation: 1,
        localOnlyFolders: localOnly === undefined ? [] : ['wiki'],
        localOnlyEditableFolders: localOnly === 'editable' ? ['wiki'] : [],
      },
      settings: {
        editorMarkdownSyntax: 'hide',
        dateFormat: 'mdy',
        wikiLanguages: [{ label: 'English', folder: 'wiki' }],
      },
      route: { kind: 'today' },
    },
  )
}

/** The heading element holding the caret, if any. */
function caretHeading(): Element | null {
  const anchor = window.getSelection()?.anchorNode ?? null
  const element = anchor instanceof Element ? anchor : (anchor?.parentElement ?? null)
  return element?.closest('h1, h2, h3, h4, h5, h6') ?? null
}

/** The element holding focus, if any. */
function focusedElement(): Element | null {
  return document.activeElement
}

it('puts the caret in the claim a ^cN link names', async () => {
  await renderFollowing('^c2')

  await expect.element(page.getByText('The wheel-of-fortune study.')).toBeInTheDocument()
  await vi.waitFor(() => expect(caretHeading()?.textContent).toContain('[C2] The canonical'))
})

it('puts the caret in a heading named by its text', async () => {
  await renderFollowing('claims')

  await expect.element(page.getByText('The wheel-of-fortune study.')).toBeInTheDocument()
  await vi.waitFor(() => expect(caretHeading()?.textContent).toBe('Claims'))
})

it('puts the caret in a repeated heading named by its numbered slug', async () => {
  await renderFollowing('next-steps-1', {
    source: [
      '# Anchoring',
      '',
      '## Next steps',
      '',
      ...Array.from({ length: 40 }, (_, index) => `Filler paragraph ${index + 1}.\n`),
      '## Next steps',
      '',
      'The second plan.',
    ].join('\n'),
  })

  await expect.element(page.getByText('The second plan.')).toBeInTheDocument()
  await vi.waitFor(() => {
    const repeats = [...document.querySelectorAll('h2')].filter(
      (heading) => heading.textContent === 'Next steps',
    )
    expect(repeats).toHaveLength(2)
    expect(caretHeading()).toBe(repeats[1])
  })
})

it('scrolls to a heading in the same note from a [[#Heading]] link', async () => {
  await renderFollowing('anchoring', {
    source: [
      '# Anchoring',
      '',
      'See [[#Evidence]] below.',
      '',
      ...Array.from({ length: 40 }, (_, index) => `Filler paragraph ${index + 1}.\n`),
      '## Evidence',
      '',
      'The wheel-of-fortune study.',
    ].join('\n'),
  })

  await page.getByTestId('wikilink').first().click()

  await vi.waitFor(() => expect(caretHeading()?.textContent).toBe('Evidence'))
})

it('reveals a claim after an editable local-only editor mounts', async () => {
  await renderFollowing('^c2', { localOnly: 'editable' })

  await expect.element(page.getByText('The wheel-of-fortune study.')).toBeInTheDocument()
  await vi.waitFor(() => expect(caretHeading()?.textContent).toContain('[C2] The canonical'))
  expect(document.querySelector('[contenteditable="true"]')).not.toBeNull()
})

it('reveals a claim in a local-only read-only preview', async () => {
  await renderFollowing('^c2', { localOnly: 'read-only' })

  await expect.element(page.getByText('The wheel-of-fortune study.')).toBeInTheDocument()
  await vi.waitFor(() => expect(focusedElement()?.textContent).toContain('[C2] The canonical'))
  expect(document.querySelector('[contenteditable="true"]')).toBeNull()
  expect(focusedElement()?.getBoundingClientRect().top).toBeLessThan(window.innerHeight)
})

it('reveals a repeated heading by its numbered slug in a read-only preview', async () => {
  await renderFollowing('next-steps-1', {
    localOnly: 'read-only',
    source: '# Anchoring\n\n## Next steps\n\nFirst.\n\n## Next steps\n\nSecond.',
  })

  await expect.element(page.getByText('Second.')).toBeInTheDocument()
  await vi.waitFor(() => {
    const headings = document.querySelectorAll('h2')
    expect(document.activeElement).toBe(headings[1])
  })
})

it('follows a same-note heading link in a read-only preview', async () => {
  await renderFollowing('anchoring', {
    localOnly: 'read-only',
    source: '# Anchoring\n\nSee [[#Evidence]].\n\n## Evidence\n\nStudy.',
  })

  await page.getByTestId('wikilink').first().click()

  await vi.waitFor(() => expect(focusedElement()?.textContent).toBe('Evidence'))
})
