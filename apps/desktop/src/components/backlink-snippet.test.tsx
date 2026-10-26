import { createTestCoreServices, type TestCoreServices } from '@reflect/core/testing'
import { userEvent } from 'vitest/browser'
import { beforeEach, describe, expect, it, onTestFinished, vi, type MockInstance } from 'vitest'
import type { SnippetTask, TaskService } from '@reflect/core'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { BacklinkSnippet } from './backlink-snippet.tsx'

/**
 * A context with one round task, one square box, and a nested round task —
 * the anchors mirror what `extractSnippetTasks` produces for this markdown
 * (exercised for real in `@reflect/core`'s tests; here they are fixtures so
 * the click wiring is what's under test).
 */
const SNIPPET = [
  '- [[Roadmap]] kickoff',
  '  + [ ] prep agenda',
  '  - [x] square box',
  '  + [x] send invite',
].join('\n')

function anchors(): SnippetTask[] {
  return [
    {
      locator: { astPath: [0, 1], markdown: 'prep agenda', checked: false },
      checked: false,
      text: 'prep agenda',
    },
    { locator: null, checked: true, text: 'square box' },
    {
      locator: { astPath: [0, 3], markdown: 'send invite', checked: true },
      checked: true,
      text: 'send invite',
    },
  ]
}

// The graph's local-only folders are `secure`.
const GRAPH = { root: '/g', name: 'g', generation: 7, localOnlyFolders: ['secure'] }

let operations: TestCoreServices['progress']
let writeTask: MockInstance<TaskService['writeTask']>

async function renderSnippet(
  tasks: SnippetTask[] = anchors(),
  text: string = SNIPPET,
  onWikilinkClick: () => void = () => {},
) {
  const core = createTestCoreServices({ database: createWasmTestDatabaseService() })
  operations = core.progress
  writeTask = vi
    .spyOn(core.tasks, 'writeTask')
    .mockResolvedValue({ source: '', moved: [], inserted: [], tasks: [], updatedAt: 0 })
  return await renderInApp(
    <BacklinkSnippet
      text={text}
      notePath="notes/meeting.md"
      sourcePrivate={false}
      tasks={tasks}
      onWikilinkClick={onWikilinkClick}
    />,
    { core, graph: GRAPH },
  )
}

describe('BacklinkSnippet task checkboxes', () => {
  it('writes a round-task click through to the source note', async () => {
    const view = await renderSnippet()
    const boxes = view.container.querySelectorAll('input[type="checkbox"]')
    expect(boxes).toHaveLength(3)
    await userEvent.click(boxes[0]!)
    await vi.waitFor(() => expect(writeTask).toHaveBeenCalledTimes(1))
    expect(writeTask).toHaveBeenCalledWith(
      { notePath: 'notes/meeting.md', astPath: [0, 1], markdown: 'prep agenda', checked: false },
      [{ kind: 'toggle' }],
    )
    await view.unmount()
  })

  it('toggles a checked round task by its own anchor', async () => {
    const view = await renderSnippet()
    const boxes = view.container.querySelectorAll('input[type="checkbox"]')
    await userEvent.click(boxes[2]!)
    await vi.waitFor(() => expect(writeTask).toHaveBeenCalledTimes(1))
    expect(writeTask).toHaveBeenCalledWith(
      { notePath: 'notes/meeting.md', astPath: [0, 3], markdown: 'send invite', checked: true },
      [{ kind: 'toggle' }],
    )
    await view.unmount()
  })

  it('leaves a square GFM checkbox read-only', async () => {
    const view = await renderSnippet()
    const boxes = view.container.querySelectorAll('input[type="checkbox"]')
    expect((boxes[1] as HTMLInputElement).checked).toBe(true)
    await userEvent.click(boxes[1]!, { force: true })
    expect(writeTask).not.toHaveBeenCalled()
    expect(operations.getAll()).toEqual([])
    await view.unmount()
  })

  it('refuses instead of toggling when the anchors disagree with the rendered task', async () => {
    // Simulate anchor drift: the anchor for index 0 claims a different state.
    const drifted = anchors()
    drifted[0] = { ...drifted[0]!, checked: true }
    const view = await renderSnippet(drifted)
    const boxes = view.container.querySelectorAll('input[type="checkbox"]')
    await userEvent.click(boxes[0]!)
    expect(writeTask).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(operations.findByLabel('Updating task')?.status).toBe('failed'))
    await view.unmount()
  })

  it('renders a collapsed source item expanded', async () => {
    // The parent is folded in the source note (`+` marker), so its line is
    // sliced into the context verbatim; the snippet must still show the
    // mention underneath instead of folding it away.
    const view = await renderSnippet([], '+ parent line\n  - mention of [[Roadmap]]')
    expect(view.container.querySelector('[data-list-collapsed]')).toBeNull()
    expect(view.container.textContent).toContain('mention of')
    await view.unmount()
  })

  it('renders checkboxes inert when the snippet has no round tasks', async () => {
    const squareOnly: SnippetTask[] = [{ locator: null, checked: true, text: 'square box' }]
    const view = await renderSnippet(squareOnly, '- [[Roadmap]] plan\n  - [x] square box')
    const box = view.container.querySelector('input[type="checkbox"]')!
    await userEvent.click(box, { force: true })
    expect(writeTask).not.toHaveBeenCalled()
    await view.unmount()
  })
})

describe('BacklinkSnippet wiki-link chips', () => {
  it('labels chips through the host resolver and reports the full target', async () => {
    const onWikilinkClick = vi.fn()
    const view = await renderSnippet(
      [],
      '- see [[Tim MacCaw // Dad|Dad]] and [[Tim MacCaw // Dad]]',
      onWikilinkClick,
    )
    const chips = view.getByTestId('wikilink')
    await expect.element(chips.first()).toMatchTextContent(/^Dad$/)
    await expect.element(chips.last()).toMatchTextContent(/^Tim MacCaw$/)
    await chips.first().click()
    // The source note rides along: the navigation decides by it whether an
    // unresolved target may be created.
    expect(onWikilinkClick).toHaveBeenCalledWith(
      expect.objectContaining({ target: 'Tim MacCaw // Dad' }),
      'notes/meeting.md',
    )
    await view.unmount()
  })
})

describe('BacklinkSnippet saved embed snapshots', () => {
  const THUMBNAIL = 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg'
  const showsImage = (container: HTMLElement, src: string): boolean => {
    return [...container.querySelectorAll('img')].some((img) => img.getAttribute('src') === src)
  }
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
  const TEXT = `- see ![](https://www.youtube.com/watch?v=dQw4w9WgXcQ)<!-- ${SNAPSHOT} -->`

  function renderFrom(notePath: string, sourcePrivate: boolean) {
    return renderInApp(
      <BacklinkSnippet
        text={TEXT}
        notePath={notePath}
        sourcePrivate={sourcePrivate}
        tasks={[]}
        onWikilinkClick={() => {}}
      />,
      { graph: GRAPH },
    )
  }

  it('never renders a snapshot card from a local-only source', async () => {
    // The path alone keeps it off the network, whatever the query said.
    const view = await renderFrom('finance/secure/bank.md', false)
    // The embed shows its source URL: no card, so the thumbnail never loads.
    await expect
      .element(view.getByTestId('embed-link'))
      .toHaveTextContent('https://www.youtube.com/watch?v=dQw4w9WgXcQ')
    expect(view.container.querySelector('[data-meowdown-embed]')).toBeNull()
    expect(showsImage(view.container, THUMBNAIL)).toBe(false)
    await view.unmount()
  })

  it('never renders a snapshot card from a locked source', async () => {
    const view = await renderFrom('notes/locked.md', true)
    await expect
      .element(view.getByTestId('embed-link'))
      .toHaveTextContent('https://www.youtube.com/watch?v=dQw4w9WgXcQ')
    expect(view.container.querySelector('[data-meowdown-embed]')).toBeNull()
    expect(showsImage(view.container, THUMBNAIL)).toBe(false)
    await view.unmount()
  })

  it('renders it from an ordinary source (control)', async () => {
    const view = await renderFrom('notes/meeting.md', false)
    await vi.waitFor(() => {
      expect(showsImage(view.container, THUMBNAIL)).toBe(true)
    })
    await view.unmount()
  })
})

describe('BacklinkSnippet network policy', () => {
  const X_URL = 'https://x.com/jack/status/777'
  const IMAGE = 'https://example.com/locked.png'
  const TEXT = `- [[Roadmap]] see ![](${X_URL}) ![](${IMAGE})`
  /** What reaches the network, or writes the X archive, on a note's behalf. */
  const REMOTE_COMMANDS = [
    'x_archive_resolve',
    'x_syndication_fetch',
    'x_archive_write',
    'capture_oembed_fetch',
  ]
  let core: TestCoreServices

  beforeEach(() => {
    core = createTestCoreServices({ database: createWasmTestDatabaseService() })
    onTestFinished(() => core.database.close())
  })

  /**
   * What reached the network or the X archive so far on the snippet's behalf:
   * bridge commands, plus the X archive's resolves, writes and syndication
   * fetches.
   */
  const commands = (): string[] => [
    ...core.ipc.calls().map((call) => call.command),
    ...core.xArchive.resolves().map(() => 'x_archive_resolve'),
    ...core.xArchive.writes().map(() => 'x_archive_write'),
    ...core.xArchive.syndicationRequests().map(() => 'x_syndication_fetch'),
  ]

  const remoteImages = (container: HTMLElement): string[] => {
    return [...container.querySelectorAll('img')]
      .map((image) => image.getAttribute('src') ?? '')
      .filter((source) => /^https?:/i.test(source))
  }

  function snippet(sourcePrivate: boolean) {
    return (
      <BacklinkSnippet
        text={TEXT}
        notePath="notes/locked.md"
        sourcePrivate={sourcePrivate}
        tasks={[]}
        onWikilinkClick={() => {}}
      />
    )
  }

  it('never looks up embeds or loads remote images for a locked tracked source', async () => {
    const view = await renderInApp(snippet(true), { core, graph: GRAPH })
    await expect.element(view.getByTestId('embed-link')).toHaveTextContent(X_URL)
    expect(remoteImages(view.container)).toEqual([])
    for (const command of REMOTE_COMMANDS) {
      expect(commands()).not.toContain(command)
    }
    await view.unmount()
  })

  it('looks them up for a public source (control)', async () => {
    const view = await renderInApp(snippet(false), { core, graph: GRAPH })
    await vi.waitFor(() => expect(commands()).toContain('x_archive_resolve'))
    await vi.waitFor(() => expect(remoteImages(view.container)).toEqual([IMAGE]))
    await view.unmount()
  })

  it('drops remote media at once when the source turns private', async () => {
    const view = await renderInApp(snippet(false), { core, graph: GRAPH })
    await vi.waitFor(() => expect(remoteImages(view.container)).toEqual([IMAGE]))

    await view.rerender(snippet(true))
    await expect.element(view.getByTestId('embed-link')).toHaveTextContent(X_URL)
    expect(remoteImages(view.container)).toEqual([])
    await view.unmount()
  })
})
