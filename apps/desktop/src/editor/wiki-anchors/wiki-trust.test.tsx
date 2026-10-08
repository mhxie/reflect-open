import { createRef } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MeowdownEditor, type EditorHandle } from '@meowdown/react'
import { setBridge, wikiClaimTextSha256 } from '@reflect/core'
import { cleanup, render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveWikilink } from '@/editor/resolve-wikilink.ts'
import { WikiArticleBridge } from './wiki-article-bridge.tsx'
import { wikiArticleKey } from './wiki-article-plugin.tsx'
import { noteArticleFor } from './wiki-article-store.ts'
import { wikiEditorRange } from './wiki-article-projection.ts'
import { WikiTrustSummary } from './wiki-trust-summary.tsx'

const settingsState = vi.hoisted(() => ({
  settings: {
    wikiTrustDisplay: 'inline',
    wikiTrustReportPath: '.harness/wiki-trust.json',
    wikiLanguages: [{ label: 'English', folder: 'wiki' }],
  },
}))
vi.mock('@/providers/settings-provider.tsx', () => ({ useSettings: () => settingsState }))
vi.mock('@/providers/graph-provider.tsx', () => ({
  useGraph: () => ({ graph: { root: '/graphs/Personal', name: 'Personal', generation: 1 } }),
}))
vi.mock('@/lib/open-url.ts', () => ({ openUrlSync: vi.fn() }))

const PATH = 'wiki/Example.md'
const SOLID = 'First claim [ref][one]'
const WEAK = 'Second claim'
const SOURCE = [
  '# Example',
  '',
  `Lead <!-- claim:c1 -->${SOLID}<!-- /claim:c1 --> and <!-- claim:c2 -->${WEAK}<!-- /claim:c2 -->.`,
  '',
  '## Evidence',
  '',
  '```anchors c1',
  '@anchor: url:https://example.org/one | valid_at: 2020-01-02',
  '```',
  '',
  '[one]: https://example.org/one "Study one"',
  '',
].join('\n')

async function reportText(): Promise<string> {
  const claim = async (tier: string, text: string, extra: object = {}): Promise<object> => ({
    tier,
    text_sha256: await wikiClaimTextSha256(text),
    evaluated_at: '2026-10-08',
    ...extra,
  })
  return JSON.stringify({
    format: 'reflect-wiki-trust',
    version: 1,
    generated_at: '2026-10-08T09:00:00Z',
    harness: { name: 'test-harness' },
    notes: {
      [PATH]: {
        claims: {
          c1: await claim('solid', SOLID, {
            reasons: [{ text: '2 independent primary sources' }],
            sources: ['host:example.org'],
          }),
          c2: await claim('needs-work', WEAK, { next: 'Add a primary source.' }),
        },
      },
    },
    sources: { 'host:example.org': { label: 'example.org', weight: 0.9, trusted: true } },
  })
}

let queryClient: QueryClient
/** The note as saved, which the view hashes. */
let disk: string
/** The report file as the harness last wrote it. */
let report: { stamp: string; contents: string }

beforeEach(async () => {
  settingsState.settings.wikiTrustDisplay = 'inline'
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  disk = SOURCE
  report = { stamp: '1:1', contents: await reportText() }
  setBridge({
    invoke: async (command) =>
      command === 'wiki_trust_report_read'
        ? report
        : command === 'note_read_local'
          ? { kind: 'content', content: disk, localOnly: false }
          : null,
    listen: async () => () => {},
  })
})

afterEach(async () => {
  await cleanup()
  queryClient.clear()
})

async function editorFixture() {
  const ref = createRef<EditorHandle>()
  const rendered = await render(
    <QueryClientProvider client={queryClient}>
      <MeowdownEditor
        initialMarkdown={SOURCE}
        mode="hide"
        handleRef={ref}
        resolveWikilink={resolveWikilink}
      >
        <WikiArticleBridge path={PATH} onWikiLinkClick={vi.fn()} />
      </MeowdownEditor>
      <WikiTrustSummary path={PATH} />
    </QueryClientProvider>,
  )
  await vi.waitFor(() => expect(ref.current?.getEditor()?.mounted).toBe(true))
  const editor = ref.current!.getEditor()!
  await vi.waitFor(() =>
    expect(
      rendered.container.querySelector('[data-wiki-claim="c2"][data-wiki-trust]'),
    ).not.toBeNull(),
  )
  return { ...rendered, editor, ref }
}

describe('claim trust from the harness report', () => {
  it('shapes the cited claim and marks the uncited one that needs work', async () => {
    const { container } = await editorFixture()
    expect(container.querySelector('[data-wiki-claim="c1"]')?.getAttribute('data-wiki-trust')).toBe(
      'solid',
    )
    await expect.element(page.getByRole('button', { name: 'Claim C1: Solid' })).toBeVisible()
    expect(container.querySelector('[data-wiki-claim="c2"]')?.getAttribute('data-wiki-trust')).toBe(
      'needs-work',
    )
    await page.getByRole('button', { name: 'Claim C2: Needs work' }).click()
    await expect.element(page.getByText('Add a primary source.')).toBeVisible()
    expect(noteArticleFor(PATH)?.trust?.needsWork).toEqual(['c2'])
  })

  it('steps to the claim that needs work from the footer summary', async () => {
    const { editor } = await editorFixture()
    await page.getByRole('button', { name: '1 needs work' }).click()
    const projection = wikiArticleKey.getState(editor.state)!
    const claim = projection.index.claims.find((item) => item.id === 'c2')!
    const range = wikiEditorRange(projection.map, claim)!
    expect(editor.state.selection.from).toBeGreaterThanOrEqual(range.from)
    expect(editor.state.selection.to).toBeLessThanOrEqual(range.to)
    expect(editor.state.selection.empty).toBe(false)
  })

  it("opens a cited claim's verdict and its weighted sources", async () => {
    await editorFixture()
    await page.getByRole('button', { name: 'Claim C1: Solid' }).click()
    await expect.element(page.getByText('2 independent primary sources')).toBeVisible()
    await expect.element(page.getByText('example.org', { exact: true })).toBeVisible()
  })

  it('shows a claim as changed as soon as its text moves on from the evaluated text', async () => {
    const { editor, container, ref } = await editorFixture()
    const projection = wikiArticleKey.getState(editor.state)!
    const claim = projection.index.claims.find((item) => item.id === 'c2')!
    editor.view.dispatch(
      editor.state.tr.insertText('Edited ', wikiEditorRange(projection.map, claim)!.from),
    )
    // Unsaved: the text differs from what was hashed.
    await vi.waitFor(() =>
      expect(
        container.querySelector('[data-wiki-claim="c2"]')?.getAttribute('data-wiki-trust'),
      ).toBe('pending'),
    )
    expect(container.querySelector('[data-wiki-claim="c1"]')?.getAttribute('data-wiki-trust')).toBe(
      'solid',
    )
    // Saved: the reindex re-reads the file, whose hash no longer matches.
    disk = ref.current!.getMarkdown()
    await queryClient.invalidateQueries({ queryKey: ['index'] })
    await vi.waitFor(() =>
      expect(
        container.querySelector('[data-wiki-claim="c2"]')?.getAttribute('data-wiki-trust'),
      ).toBe('pending'),
    )
  })

  it('records a question as a reader flag in the claim ledger', async () => {
    const { ref } = await editorFixture()
    await page.getByRole('button', { name: 'Claim C2: Needs work' }).click()
    await page.getByRole('button', { name: 'Question this claim' }).click()
    await vi.waitFor(() =>
      expect(ref.current!.getMarkdown()).toMatch(
        /```anchors c2\n@pass: reader \| status: flagged \| at: \d{4}-\d{2}-\d{2}\n```/,
      ),
    )
    expect(ref.current!.getMarkdown()).not.toContain('@pass: editor')
    await expect.element(page.getByText('You questioned this claim today.')).toBeVisible()
  })

  it('keeps the last report while a new one fails to parse', async () => {
    const { container } = await editorFixture()
    report = { stamp: '2:1', contents: '{"format":' }
    await queryClient.refetchQueries({ queryKey: ['wiki-trust'] })
    expect(queryClient.getQueriesData({ queryKey: ['wiki-trust'] })[0]?.[1]).toMatchObject({
      status: 'invalid',
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(container.querySelector('[data-wiki-claim="c1"]')?.getAttribute('data-wiki-trust')).toBe(
      'solid',
    )
    await expect.element(page.getByRole('button', { name: 'Claim C1: Solid' })).toBeVisible()
  })

  it('holds marks back on demand until Option reveals them', async () => {
    settingsState.settings.wikiTrustDisplay = 'on-demand'
    const { container } = await editorFixture()
    await vi.waitFor(() =>
      expect(container.querySelector('[data-wiki-trust-claim="c2"]')).not.toBeNull(),
    )
    expect(container.querySelector('[data-wiki-trust-claim="c2"]')).not.toBeVisible()
    const mark = page.getByRole('button', { name: 'Claim C2: Needs work' })
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt', altKey: true }))
    await expect.element(mark).toBeVisible()
    await mark.click()
    await expect.element(page.getByText('Add a primary source.')).toBeVisible()
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Alt' }))
    expect(container.querySelector('[data-wiki-trust-reveal]')).toBeNull()
  })

  it('closes the open card when its mark is pressed again', async () => {
    await editorFixture()
    const mark = page.getByRole('button', { name: 'Claim C2: Needs work' })
    await mark.click()
    await expect.element(page.getByText('Add a primary source.')).toBeVisible()
    await mark.click()
    await expect.element(page.getByText('Add a primary source.')).not.toBeInTheDocument()
  })

  it('draws nothing for a note the report leaves out', async () => {
    report = {
      stamp: '3:1',
      contents: JSON.stringify({ ...JSON.parse(report.contents), notes: {} }),
    }
    const { container } = await render(
      <QueryClientProvider client={queryClient}>
        <MeowdownEditor initialMarkdown={SOURCE} mode="hide" resolveWikilink={resolveWikilink}>
          <WikiArticleBridge path={PATH} onWikiLinkClick={vi.fn()} />
        </MeowdownEditor>
        <WikiTrustSummary path={PATH} />
      </QueryClientProvider>,
    )
    await vi.waitFor(() => expect(container.querySelector('[data-wiki-claim="c1"]')).not.toBeNull())
    await queryClient.refetchQueries({ queryKey: ['wiki-trust'] })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(container.querySelector('[data-wiki-trust]')).toBeNull()
    expect(container.querySelector('.wiki-trust-mark')).toBeNull()
  })

  it('draws marks in the margin instead when that style is chosen', async () => {
    settingsState.settings.wikiTrustDisplay = 'margin'
    const { container } = await editorFixture()
    await vi.waitFor(() =>
      expect(container.querySelectorAll('.wiki-trust-margin .wiki-trust-mark')).toHaveLength(2),
    )
    expect(container.querySelector('.ProseMirror')?.getAttribute('data-wiki-trust-display')).toBe(
      'margin',
    )
  })
})
