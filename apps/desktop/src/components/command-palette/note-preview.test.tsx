import { createTestCoreServices } from '@reflect/core/testing'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { NotePreview } from './note-preview.tsx'

/** The props each rendered preview received. */
const previews = vi.hoisted((): Array<{ content: string; remoteEmbeds?: boolean }> => [])
vi.mock('@/editor/markdown-preview.tsx', () => ({
  MarkdownPreview: (props: { content: string; remoteEmbeds?: boolean }) => {
    previews.push(props)
    return <span data-testid="markdown-preview">{props.content}</span>
  },
}))
// The graph's local-only folders are `secure`.
const GRAPH = { root: '/g', name: 'g', generation: 1, localOnlyFolders: ['secure'] }

async function renderedFor(path: string): Promise<{ remoteEmbeds?: boolean }> {
  previews.length = 0
  const app = createTestCoreServices({ database: createWasmTestDatabaseService() })
  onTestFinished(() => app.database.close())
  vi.spyOn(app.noteDocuments, 'readSource').mockResolvedValue('A body with an embed.\n')
  const view = await renderInApp(
    <NotePreview
      entry={{
        isPrivate: false,
        path,
        title: 'T',
        date: null,
        snippet: null,
        phrase: null,
        alias: null,
        related: false,
      }}
    />,
    { core: app, graph: GRAPH, settings: { dateFormat: 'mdy' } },
  )
  await expect.element(view.getByTestId('markdown-preview')).toBeVisible()
  await view.unmount()
  return previews.at(-1)!
}

describe('NotePreview', () => {
  it('previews a local-only note without remote embeds', async () => {
    expect((await renderedFor('finance/secure/bank.md')).remoteEmbeds).toBe(false)
  })

  it('previews an ordinary note with them (control)', async () => {
    expect((await renderedFor('notes/plan.md')).remoteEmbeds).toBe(true)
  })
})
