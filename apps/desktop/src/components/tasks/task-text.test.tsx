import { render } from 'vitest-browser-react'
import { describe, expect, it, vi } from 'vitest'
import { makeOpenTask as task } from '@/lib/tasks/open-task-fixture.ts'
import { TaskText } from './task-text.tsx'

/** The props each rendered preview received. */
const previews = vi.hoisted((): Array<{ content: string; remoteEmbeds?: boolean }> => [])
vi.mock('@/editor/markdown-preview.tsx', () => ({
  MarkdownPreview: (props: { content: string; remoteEmbeds?: boolean }) => {
    previews.push(props)
    return <span data-testid="markdown-preview">{props.content}</span>
  },
}))
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  // The graph's local-only folders are `secure`.
  isLocalOnlyPath: (path: string) => path.split('/').slice(0, -1).includes('secure'),
}))

async function renderedFor(notePath: string): Promise<{ remoteEmbeds?: boolean }> {
  previews.length = 0
  const view = await render(<TaskText task={task({ notePath, text: 'watch the talk' })} />)
  await expect.element(view.getByTestId('markdown-preview')).toBeVisible()
  await view.unmount()
  return previews.at(-1)!
}

describe('TaskText', () => {
  it('renders a task from a local-only note without remote embeds', async () => {
    expect((await renderedFor('finance/secure/bank.md')).remoteEmbeds).toBe(false)
  })

  it('renders an ordinary task with them (control)', async () => {
    expect((await renderedFor('notes/plan.md')).remoteEmbeds).toBe(true)
  })
})
