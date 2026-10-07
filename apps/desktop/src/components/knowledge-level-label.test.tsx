import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render } from 'vitest-browser-react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { KNOWLEDGE_LEVELS_PATH, setBridge } from '@reflect/core'
import { KnowledgeLevelLabel } from './knowledge-level-label.tsx'

vi.mock('@/providers/graph-provider.tsx', () => ({
  useGraph: () => ({ graph: { root: '/g', name: 'g', generation: 7 } }),
}))

const contract = {
  version: 1,
  levels: [
    { level: 1, label: 'Capture' },
    { level: 2, label: 'Working' },
    { level: 3, label: 'Sources' },
    { level: 4, label: 'Wiki' },
  ],
  rules: [
    { path: 'capture', match: 'tree', level: 1 },
    { path: 'notes', match: 'tree', level: 2 },
    { path: 'sources', match: 'tree', level: 3 },
    { path: 'wiki', match: 'tree', level: 4 },
    { path: 'wiki-cn', match: 'tree', level: 4, role: 'shadow' },
  ],
}
let source: string | null
const invoke = vi.fn()

beforeEach(() => {
  source = JSON.stringify(contract)
  invoke.mockReset()
  invoke.mockImplementation(async () => {
    if (source === null) throw { kind: 'notFound', message: 'No level contract' }
    return source
  })
  setBridge({ invoke, listen: async () => () => {} })
})

afterEach(async () => {
  await cleanup()
  setBridge(null)
})

it('shows all four declared levels from one graph-pinned read and identifies translations', async () => {
  const client = new QueryClient()
  const view = await render(
    <QueryClientProvider client={client}>
      {['capture/a.md', 'notes/a.md', 'sources/a.md', 'wiki/a.md', 'wiki-cn/a.md'].map((path) => (
        <KnowledgeLevelLabel key={path} path={path} />
      ))}
    </QueryClientProvider>,
  )
  for (const label of [
    'L1 · Capture',
    'L2 · Working',
    'L3 · Sources',
    'L4 · Wiki',
    'L4 · Wiki · Translation',
  ]) {
    await expect.element(view.getByText(label, { exact: true })).toBeVisible()
  }
  await expect
    .element(view.getByText('L4 · Wiki · Translation', { exact: true }))
    .toHaveAttribute(
      'title',
      'Translation of a source entry. This knowledge layer does not establish independent validation.',
    )
  expect(invoke).toHaveBeenCalledTimes(1)
  expect(invoke).toHaveBeenCalledWith('note_read', { path: KNOWLEDGE_LEVELS_PATH, generation: 7 })
  window.dispatchEvent(new Event('focus'))
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2))
  await view.unmount()
  window.dispatchEvent(new Event('focus'))
  expect(invoke).toHaveBeenCalledTimes(2)
})

it('leaves ordinary graphs without a contract unclassified', async () => {
  source = null
  const client = new QueryClient()
  const view = await render(
    <QueryClientProvider client={client}>
      <KnowledgeLevelLabel path="wiki/a.md" />
    </QueryClientProvider>,
  )
  await vi.waitFor(() => expect(client.isFetching()).toBe(0))
  expect(view.container.textContent).toBe('')
})

it('shows only the level in a compact column, including translations', async () => {
  const view = await render(
    <QueryClientProvider client={new QueryClient()}>
      <KnowledgeLevelLabel path="wiki-cn/a.md" compact />
    </QueryClientProvider>,
  )
  await expect.element(view.getByText('L4', { exact: true })).toBeVisible()
  expect(view.container.textContent).toBe('L4')
  await expect
    .element(view.getByText('L4', { exact: true }))
    .toHaveAttribute('title', expect.stringContaining('L4 · Wiki.'))
})

it('does not assign a level to paths outside the declared rules', async () => {
  const client = new QueryClient()
  const view = await render(
    <QueryClientProvider client={client}>
      <KnowledgeLevelLabel path="other/a.md" />
    </QueryClientProvider>,
  )
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1))
  await vi.waitFor(() => expect(client.isFetching()).toBe(0))
  expect(view.container.textContent).toBe('')
})

it('shows unavailable without inventing a tier for an invalid contract', async () => {
  source = '{"version":2}'
  const view = await render(
    <QueryClientProvider client={new QueryClient()}>
      <KnowledgeLevelLabel path="wiki/a.md" />
    </QueryClientProvider>,
  )
  await expect.element(view.getByLabelText('Knowledge level unavailable')).toBeVisible()
  expect(view.container.querySelector('[data-knowledge-level]')).toBeNull()
})

it('reloads sidecar changes on window focus even while the cached copy is fresh', async () => {
  const view = await render(
    <QueryClientProvider client={new QueryClient()}>
      <KnowledgeLevelLabel path="wiki/a.md" />
    </QueryClientProvider>,
  )
  await expect.element(view.getByText('L4 · Wiki', { exact: true })).toBeVisible()
  source = JSON.stringify({
    ...contract,
    levels: contract.levels.map((level) =>
      level.level === 4 ? { ...level, label: 'Updated wiki' } : level,
    ),
  })
  window.dispatchEvent(new Event('focus'))
  await expect.element(view.getByText('L4 · Updated wiki', { exact: true })).toBeVisible()
  expect(invoke).toHaveBeenCalledTimes(2)
})
