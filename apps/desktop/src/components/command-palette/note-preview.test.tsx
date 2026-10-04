import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from 'vitest-browser-react'
import { describe, expect, it, vi } from 'vitest'
import { NotePreview } from './note-preview.tsx'

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
  readNote: async () => 'A body with an embed.\n',
  // The graph's local-only folders are `secure`.
  isLocalOnlyPath: (path: string) => path.split('/').slice(0, -1).includes('secure'),
}))
vi.mock('@/providers/graph-provider.tsx', () => ({
  useGraph: () => ({
    graph: { root: '/g', name: 'g', generation: 1, localOnlyFolders: ['secure'] },
  }),
}))
vi.mock('@/providers/settings-provider.tsx', () => ({
  useSettings: () => ({ settings: { dateFormat: 'mdy' } }),
}))

async function renderedFor(path: string): Promise<{ remoteEmbeds?: boolean }> {
  previews.length = 0
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = await render(
    <QueryClientProvider client={client}>
      <NotePreview
        entry={{
          path,
          title: 'T',
          date: null,
          snippet: null,
          phrase: null,
          alias: null,
          related: false,
        }}
      />
    </QueryClientProvider>,
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
