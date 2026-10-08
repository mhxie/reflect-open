import { createRef } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MeowdownEditor, type EditorHandle } from '@meowdown/react'
import { emitFileChanges, setBridge, wikiClaimTextSha256 } from '@reflect/core'
import { cleanup, render } from 'vitest-browser-react'
import { page, userEvent } from 'vitest/browser'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveWikilink } from '@/editor/resolve-wikilink.ts'
import { WikiArticleBridge } from './wiki-article-bridge.tsx'
import { savedFileRetryMs } from './use-wiki-trust-view.ts'
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
// Frontmatter, a table, and a lazy blockquote: Markdown the editor may
// re-serialize, which must not read as an unsaved edit.
const SOURCE = [
  '---',
  'tags: [wiki]',
  '---',
  '# Example',
  '',
  '> A quote',
  'lazy continuation',
  '',
  '| a | b |',
  '|---|---|',
  '| 1 | 2 |',
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

/** A report; `weak` is the c2 text the harness evaluated. */
async function reportText(weak = WEAK): Promise<string> {
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
          c2: await claim('needs-work', weak, { next: 'Add a primary source.' }),
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
/** Holds note reads until it resolves, when a test sets it. */
let readGate: Promise<void> | null
/** Note reads still to fail. */
let readFailures: number
/** Note reads made. */
let reads: number

beforeEach(async () => {
  settingsState.settings.wikiTrustDisplay = 'inline'
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  disk = SOURCE
  readGate = null
  readFailures = 0
  reads = 0
  report = { stamp: '1:1', contents: await reportText() }
  setBridge({
    invoke: async (command, args) =>
      command === 'wiki_trust_report_read'
        ? {
            stamp: report.stamp,
            // As Rust does: the caller's copy is current, so no contents.
            contents:
              (args as { knownStamp: string | null }).knownStamp === report.stamp
                ? null
                : report.contents,
          }
        : command === 'note_read_local'
          ? await (readGate ?? Promise.resolve()).then(() => {
              reads += 1
              if (readFailures > 0) {
                readFailures -= 1
                throw new Error('read failed')
              }
              return {
                kind: 'content',
                content: disk,
                localOnly: false,
              }
            })
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
    const weak = container.querySelector<HTMLElement>('[data-wiki-claim="c2"]')!
    expect(weak.getAttribute('data-wiki-trust')).toBe('needs-work')
    // Underlined in the tier's color, not the text's.
    await vi.waitFor(() => {
      const style = getComputedStyle(weak)
      expect(style.textDecorationLine).toBe('underline')
      expect(style.textDecorationColor).not.toBe(style.color)
    })
    await page.getByRole('button', { name: 'Claim C2: Needs work' }).click()
    await expect.element(page.getByText('Add a primary source.')).toBeVisible()
    expect(noteArticleFor(PATH)?.trust?.needsWork).toEqual(['c2'])
  })

  it('keeps an inline mark from covering the prose beside it', async () => {
    const { container } = await editorFixture()
    const mark = container.querySelector<HTMLElement>('[data-wiki-trust-claim="c2"]')!
    const box = mark.getBoundingClientRect()
    const y = box.top + box.height / 2
    // WCAG 2.5.8 exempts a target in a sentence; a press beside it places the caret.
    expect(document.elementFromPoint(box.left - 3, y)?.closest('.wiki-trust-mark')).toBeNull()
    expect(document.elementFromPoint(box.right + 3, y)?.closest('.wiki-trust-mark')).toBeNull()
  })

  it('adds nothing to a sound article but one silent mark per claim', async () => {
    const sound = JSON.parse(report.contents) as {
      notes: Record<string, { claims: Record<string, { tier: string; next?: string }> }>
    }
    const c2 = sound.notes[PATH]!.claims['c2']!
    c2.tier = 'solid'
    delete c2.next
    report = { stamp: '2:2', contents: JSON.stringify(sound) }
    const { container } = await editorFixture()
    await vi.waitFor(() =>
      expect(
        container.querySelector('[data-wiki-claim="c2"]')?.getAttribute('data-wiki-trust'),
      ).toBe('solid'),
    )
    // One mark per claim, carrying meaning by shape alone: no text in the prose.
    const marks = [...container.querySelectorAll<HTMLElement>('.wiki-trust-mark')]
    expect(marks).toHaveLength(2)
    for (const mark of marks) expect(mark.textContent).toBe('')
    // Sound prose stays clean: no underline, no tint.
    for (const claim of container.querySelectorAll<HTMLElement>('[data-wiki-claim]')) {
      const style = getComputedStyle(claim)
      expect(style.textDecorationLine).toBe('none')
      expect(style.backgroundColor).toBe('rgba(0, 0, 0, 0)')
    }
    // And the footer says nothing.
    expect(container.textContent).not.toMatch(/needs? work|not yet evaluated/)
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
    // A reindex for some other change re-reads the same file: still unsaved.
    await queryClient.invalidateQueries({ queryKey: ['index'] })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(container.querySelector('[data-wiki-claim="c2"]')?.getAttribute('data-wiki-trust')).toBe(
      'pending',
    )
    // Saved: the reindex re-reads the file, whose hash no longer matches.
    disk = ref.current!.getMarkdown()
    await queryClient.invalidateQueries({ queryKey: ['index'] })
    await vi.waitFor(() =>
      expect(
        container.querySelector('[data-wiki-claim="c2"]')?.getAttribute('data-wiki-trust'),
      ).toBe('pending'),
    )
    // Evaluated as saved: the editor's own output reads clean against it.
    report = { stamp: '9:9', contents: await reportText(`Edited ${WEAK}`) }
    await queryClient.refetchQueries({ queryKey: ['wiki-trust'] })
    await vi.waitFor(() =>
      expect(
        container.querySelector('[data-wiki-claim="c2"]')?.getAttribute('data-wiki-trust'),
      ).toBe('needs-work'),
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

  it('marks a claim edited while the saved file is still being read', async () => {
    let release = (): void => {}
    readGate = new Promise((resolve) => {
      release = resolve
    })
    const ref = createRef<EditorHandle>()
    const { container } = await render(
      <QueryClientProvider client={queryClient}>
        <MeowdownEditor
          initialMarkdown={SOURCE}
          mode="hide"
          handleRef={ref}
          resolveWikilink={resolveWikilink}
        >
          <WikiArticleBridge path={PATH} onWikiLinkClick={vi.fn()} />
        </MeowdownEditor>
      </QueryClientProvider>,
    )
    await vi.waitFor(() => expect(ref.current?.getEditor()?.mounted).toBe(true))
    const editor = ref.current!.getEditor()!
    await vi.waitFor(() => expect(wikiArticleKey.getState(editor.state)).toBeDefined())
    const projection = wikiArticleKey.getState(editor.state)!
    const claim = projection.index.claims.find((item) => item.id === 'c1')!
    editor.view.dispatch(
      editor.state.tr.insertText('Edited ', wikiEditorRange(projection.map, claim)!.from),
    )
    release()
    await vi.waitFor(() =>
      expect(
        container.querySelector('[data-wiki-claim="c1"]')?.getAttribute('data-wiki-trust'),
      ).toBe('pending'),
    )
    expect(container.querySelector('[data-wiki-claim="c2"]')?.getAttribute('data-wiki-trust')).toBe(
      'needs-work',
    )
  })

  it('keeps citation widgets in place when a new report arrives', async () => {
    const { container } = await editorFixture()
    const citation = container.querySelector('.wiki-article-reference')
    expect(citation).not.toBeNull()
    report = { stamp: '5:5', contents: await reportText() }
    await queryClient.refetchQueries({ queryKey: ['wiki-trust'] })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(citation?.isConnected).toBe(true)
  })

  it('writes no question into a ledger that does not count', async () => {
    // c2's only ledger sits in the prose, outside Evidence: invalid.
    disk = SOURCE.replace('## Evidence', '```anchors c2\n```\n\n## Evidence')
    const ref = createRef<EditorHandle>()
    await render(
      <QueryClientProvider client={queryClient}>
        <MeowdownEditor
          initialMarkdown={disk}
          mode="hide"
          handleRef={ref}
          resolveWikilink={resolveWikilink}
        >
          <WikiArticleBridge path={PATH} onWikiLinkClick={vi.fn()} />
        </MeowdownEditor>
      </QueryClientProvider>,
    )
    await page.getByRole('button', { name: 'Claim C2: Needs work' }).click()
    await page.getByRole('button', { name: 'Question this claim' }).click()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(ref.current!.getMarkdown()).not.toContain('@pass: reader')
    await expect.element(page.getByText(/evidence ledger needs fixing/)).toBeVisible()
  })

  it('rereads the saved file for a new report, not for an unchanged poll', async () => {
    await editorFixture()
    await new Promise((resolve) => setTimeout(resolve, 50))
    const settled = reads
    await queryClient.refetchQueries({ queryKey: ['wiki-trust'] })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(reads).toBe(settled)
    report = { stamp: '7:7', contents: await reportText() }
    await queryClient.refetchQueries({ queryKey: ['wiki-trust'] })
    await vi.waitFor(() => expect(reads).toBe(settled + 1))
  })

  it('rereads the saved file when that file changes, not when another does', async () => {
    await editorFixture()
    await new Promise((resolve) => setTimeout(resolve, 50))
    const settled = reads
    emitFileChanges([{ path: 'wiki/Other.md', kind: 'upsert' }], 'own-write')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(reads).toBe(settled)
    emitFileChanges([{ path: PATH, kind: 'upsert' }], 'own-write')
    await vi.waitFor(() => expect(reads).toBe(settled + 1))
  })

  it('reads again when the file changes during the first read', async () => {
    let release = (): void => {}
    readGate = new Promise((resolve) => {
      release = resolve
    })
    await render(
      <QueryClientProvider client={queryClient}>
        <MeowdownEditor initialMarkdown={SOURCE} mode="hide" resolveWikilink={resolveWikilink}>
          <WikiArticleBridge path={PATH} onWikiLinkClick={vi.fn()} />
        </MeowdownEditor>
      </QueryClientProvider>,
    )
    await vi.waitFor(() => expect(reads).toBe(0))
    await new Promise((resolve) => setTimeout(resolve, 50))
    emitFileChanges([{ path: PATH, kind: 'upsert' }], 'external')
    release()
    await vi.waitFor(() => expect(reads).toBe(2))
  })

  it('rereads the saved file when the window regains focus', async () => {
    await editorFixture()
    await new Promise((resolve) => setTimeout(resolve, 50))
    const settled = reads
    window.dispatchEvent(new Event('focus'))
    await vi.waitFor(() => expect(reads).toBeGreaterThan(settled))
  })

  it('drops verdicts while the saved file cannot be read, then recovers', async () => {
    const { container } = await editorFixture()
    const c1 = (): string | null | undefined =>
      container.querySelector('[data-wiki-claim="c1"]')?.getAttribute('data-wiki-trust')
    expect(c1()).toBe('solid')
    // A reread that fails: the cache keeps the old hashes, which must not show.
    readFailures = 1
    report = { stamp: '8:8', contents: await reportText() }
    await queryClient.refetchQueries({ queryKey: ['wiki-trust'] })
    await vi.waitFor(() => expect(c1()).toBeNull())
    report = { stamp: '9:9', contents: await reportText() }
    await queryClient.refetchQueries({ queryKey: ['wiki-trust'] })
    await vi.waitFor(() => expect(c1()).toBe('solid'))
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
    // Hidden: the mark's wrapper collapses to nothing (it stays focusable).
    const wrapper = container.querySelector('[data-wiki-trust-claim="c2"]')!.parentElement!
    expect(wrapper.getBoundingClientRect().width).toBe(0)
    expect(getComputedStyle(wrapper).opacity).toBe('0')
    const mark = page.getByRole('button', { name: 'Claim C2: Needs work' })
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt', altKey: true }))
    await expect.element(mark).toBeVisible()
    await mark.click()
    await expect.element(page.getByText('Add a primary source.')).toBeVisible()
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Alt' }))
    expect(container.querySelector('[data-wiki-trust-reveal]')).toBeNull()
    // The open card keeps its mark, and so its anchor, after Option is released.
    await expect.element(mark).toBeVisible()
    await expect.element(page.getByText('Add a primary source.')).toBeVisible()
    // Escape returns focus to the mark, which stays shown while focused.
    await userEvent.keyboard('{Escape}')
    await expect.element(page.getByText('Add a primary source.')).not.toBeInTheDocument()
    const element = container.querySelector('[data-wiki-trust-claim="c2"]')
    await vi.waitFor(() => expect(document.activeElement).toBe(element))
    await expect.element(mark).toBeVisible()
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
    // Stacked marks sit 24px apart at any root size, so their 24px hit areas
    // tile without overlap: just inside each one's area hits it.
    for (const root of ['16px', '13px']) {
      document.documentElement.style.fontSize = root
      const [first, second] = [
        ...container.querySelectorAll<HTMLElement>('.wiki-trust-margin .wiki-trust-mark'),
      ].map((item) => item.getBoundingClientRect())
      const pitch = second!.top + second!.height / 2 - (first!.top + first!.height / 2)
      expect(pitch).toBeGreaterThanOrEqual(23.5)
    }
    document.documentElement.style.fontSize = ''
    // A right gutter, as the app has, keeps the column in the viewport.
    ;(container as HTMLElement).style.cssText = 'width: 560px; padding-right: 64px'
    const [upper, lower] = [
      ...container.querySelectorAll<HTMLElement>('.wiki-trust-margin .wiki-trust-mark'),
    ]
    const top = upper!.getBoundingClientRect()
    const bottom = lower!.getBoundingClientRect()
    const x = top.left + top.width / 2
    expect(
      document.elementFromPoint(x, top.top + top.height / 2 + 10)?.closest('.wiki-trust-mark'),
    ).toBe(upper)
    expect(
      document
        .elementFromPoint(x, bottom.top + bottom.height / 2 - 10)
        ?.closest('.wiki-trust-mark'),
    ).toBe(lower)
    // The paragraph reserves the column's height, so the next one's marks cannot overlap.
    const column = container.querySelector('.wiki-trust-margin')!.getBoundingClientRect()
    const host = container.querySelector('.wiki-trust-margin-host')!.getBoundingClientRect()
    expect(column.bottom).toBeLessThanOrEqual(host.bottom + 0.5)
    expect(container.querySelector('.ProseMirror')?.getAttribute('data-wiki-trust-display')).toBe(
      'margin',
    )
  })
})

describe('savedFileRetryMs', () => {
  it('polls an evicted note, retries a failed read more slowly, and otherwise waits', () => {
    expect(savedFileRetryMs({ status: 'success', data: 'evicted' })).toBe(5000)
    expect(savedFileRetryMs({ status: 'error', data: 'evicted' })).toBe(30_000)
    expect(savedFileRetryMs({ status: 'error' })).toBe(30_000)
    expect(savedFileRetryMs({ status: 'success', data: {} })).toBe(false)
    expect(savedFileRetryMs({ status: 'pending' })).toBe(false)
  })
})
