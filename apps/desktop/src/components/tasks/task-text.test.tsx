import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoteRow } from '@reflect/core'
import { createTestCoreServices, makeOpenTask } from '@reflect/core/testing'
import { MarkdownPreview } from '@/editor/markdown-preview.tsx'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { TaskText } from './task-text.tsx'

/** The props each rendered preview received. */
const previews = vi.hoisted((): Array<{ content: string; remoteEmbeds?: boolean }> => [])
vi.mock('@/editor/markdown-preview.tsx', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/editor/markdown-preview.tsx')>()
  return {
    MarkdownPreview: (props: Parameters<typeof original.MarkdownPreview>[0]) => {
      previews.push(props)
      return (
        <span data-testid="markdown-preview">
          <original.MarkdownPreview {...props} />
        </span>
      )
    },
  }
})

// The graph's local-only folders are `secure`.
const GRAPH = { root: '/g', name: 'g', generation: 7, localOnlyFolders: ['secure'] }

const getNote = vi.fn<(path: string) => Promise<NoteRow | undefined>>()

function row(path: string, isPrivate: boolean): NoteRow {
  return {
    path,
    title: 'Plan',
    dailyDate: null,
    isPrivate,
    gistUrl: null,
    gistStale: false,
  }
}

beforeEach(() => {
  previews.length = 0
  getNote
    .mockReset()
    .mockImplementation((path) => Promise.resolve(row(path, path === 'notes/locked.md')))
})

async function renderFor(notePath: string): Promise<void> {
  const app = createTestCoreServices()
  vi.spyOn(app.indexQuery, 'getNote').mockImplementation(getNote)
  const view = await renderInApp(
    <TaskText task={makeOpenTask({ notePath, text: 'watch the talk' })} />,
    { app, graph: GRAPH },
  )
  await expect.element(view.getByTestId('markdown-preview')).toBeVisible()
}

/**
 * Lets the note row query settle, then checks no preview ever allowed remote embeds.
 */
async function expectNoRemoteEmbeds(notePath: string): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(previews.length).toBeGreaterThan(0)
  expect(
    previews.every((props) => props.remoteEmbeds === false),
    notePath,
  ).toBe(true)
}

describe('TaskText', () => {
  it('renders an ordinary task with remote embeds once its note is known public', async () => {
    await renderFor('notes/plan.md')
    // Fail closed until the row lands.
    expect(previews[0]?.remoteEmbeds).toBe(false)
    await vi.waitFor(() => expect(getNote).toHaveBeenCalledWith('notes/plan.md'))
    await vi.waitFor(() => expect(previews.at(-1)?.remoteEmbeds).toBe(true))
  })

  it('renders a task from a locked note without them', async () => {
    await renderFor('notes/locked.md')
    await vi.waitFor(() => expect(getNote).toHaveBeenCalledWith('notes/locked.md'))
    await expectNoRemoteEmbeds('notes/locked.md')
  })

  it('renders a task from a local-only note without them', async () => {
    await renderFor('finance/secure/bank.md')
    await expectNoRemoteEmbeds('finance/secure/bank.md')
  })

  it('renders a task without them while its note has no row', async () => {
    getNote.mockResolvedValue(undefined)
    await renderFor('notes/unindexed.md')
    await vi.waitFor(() => expect(getNote).toHaveBeenCalledWith('notes/unindexed.md'))
    await expectNoRemoteEmbeds('notes/unindexed.md')
  })

  it('renders a task marker at the start of the text as text, not a checkbox', async () => {
    const view = await renderInApp(
      <TaskText task={makeOpenTask({ notePath: 'notes/plan.md', markdown: '+ [ ] task' })} />,
      { graph: GRAPH },
    )
    expect(view.container.textContent).toContain('+ [ ] task')
    expect(view.container.querySelector('input[type="checkbox"]')).toBeNull()
    await view.unmount()
  })

  it('would render that marker as a checkbox without single-paragraph mode', async () => {
    const view = await renderInApp(<MarkdownPreview content="+ [ ] task" sourcePath={null} />, {
      graph: GRAPH,
    })
    expect(view.container.querySelector('input[type="checkbox"]')).not.toBeNull()
    await view.unmount()
  })
})
