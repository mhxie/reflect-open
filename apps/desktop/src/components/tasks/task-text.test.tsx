import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from 'vitest-browser-react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoteRow } from '@reflect/core'
import { makeOpenTask as task } from '@/lib/tasks/open-task-fixture.ts'
import { MarkdownPreview } from '@/editor/markdown-preview.tsx'
import { TaskText } from './task-text.tsx'

/** The props each rendered preview received. */
const previews = vi.hoisted((): Array<{ content: string; remoteEmbeds?: boolean }> => [])
const getNote = vi.hoisted(() => vi.fn<(path: string) => Promise<NoteRow | undefined>>())
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
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  getNote,
  // The graph's local-only folders are `secure`.
  isLocalOnlyPath: (path: string) => path.split('/').slice(0, -1).includes('secure'),
}))
vi.mock('@/providers/graph-provider.tsx', () => ({
  useGraph: () => ({ graph: { root: '/g', name: 'g', generation: 1 } }),
}))

function row(path: string, isPrivate: boolean): NoteRow {
  return {
    path,
    title: 'Plan',
    dailyDate: null,
    isPrivate,
    hasConflict: false,
    gistUrl: null,
    gistStale: false,
  }
}

beforeEach(() => {
  previews.length = 0
  getNote.mockReset().mockImplementation(async (path) => row(path, path === 'notes/locked.md'))
})

async function renderFor(notePath: string): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = await render(
    <QueryClientProvider client={client}>
      <TaskText task={task({ notePath, text: 'watch the talk' })} />
    </QueryClientProvider>,
  )
  await expect.element(view.getByTestId('markdown-preview')).toBeVisible()
  await vi.waitFor(() => expect(getNote).toHaveBeenCalledWith(notePath))
}

describe('TaskText', () => {
  it('renders an ordinary task with remote embeds once its note is known public', async () => {
    await renderFor('notes/plan.md')
    // Fail closed until the row lands.
    expect(previews[0]?.remoteEmbeds).toBe(false)
    await vi.waitFor(() => expect(previews.at(-1)?.remoteEmbeds).toBe(true))
  })

  it('renders a task from a locked note without them', async () => {
    await renderFor('notes/locked.md')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(previews.every((props) => props.remoteEmbeds === false)).toBe(true)
  })

  it('renders a task from a local-only note without them', async () => {
    await renderFor('finance/secure/bank.md')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(previews.every((props) => props.remoteEmbeds === false)).toBe(true)
  })

  it('renders a task without them while its note has no row', async () => {
    getNote.mockResolvedValue(undefined)
    await renderFor('notes/unindexed.md')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(previews.every((props) => props.remoteEmbeds === false)).toBe(true)
  })

  it('renders a task marker at the start of the text as text, not a checkbox', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = await render(
      <QueryClientProvider client={client}>
        <TaskText task={task({ notePath: 'notes/plan.md', markdown: '+ [ ] task' })} />
      </QueryClientProvider>,
    )
    expect(view.container.textContent).toContain('+ [ ] task')
    expect(view.container.querySelector('input[type="checkbox"]')).toBeNull()
    await view.unmount()
  })

  it('would render that marker as a checkbox without single-paragraph mode', async () => {
    const view = await render(<MarkdownPreview content="+ [ ] task" />)
    expect(view.container.querySelector('input[type="checkbox"]')).not.toBeNull()
    await view.unmount()
  })
})
