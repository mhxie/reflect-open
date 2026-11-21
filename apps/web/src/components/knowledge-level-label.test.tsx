import { expect, it, onTestFinished, vi } from 'vitest'
import type { ReactNode } from 'react'
import { KNOWLEDGE_LEVELS_PATH } from '@reflect/core'
import {
  createTestCoreServices,
  createTestNoteFileService,
  type TestNoteFileService,
} from '@reflect/core/testing'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { KnowledgeLevelLabel } from './knowledge-level-label.tsx'

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

/**
 * `ui` over a graph of generation 7 whose level contract is `source` (`null`: none).
 */
async function renderLabels(ui: ReactNode, source: string | null = JSON.stringify(contract)) {
  const noteFile = createTestNoteFileService({
    files: source === null ? {} : { [KNOWLEDGE_LEVELS_PATH]: source },
  })
  const app = createTestCoreServices({ database: createWasmTestDatabaseService(), noteFile })
  onTestFinished(() => app.database.close())
  const view = await renderInApp(ui, { core: app, graph: { root: '/g', name: 'g', generation: 7 } })
  return Object.assign(view, { noteFile, contractReads: () => contractReads(noteFile) })
}

function contractReads(noteFile: TestNoteFileService) {
  return noteFile.getReads().filter((read) => read.path === KNOWLEDGE_LEVELS_PATH)
}

it('shows all four declared levels from one graph-pinned read and identifies translations', async () => {
  const view = await renderLabels(
    ['capture/a.md', 'notes/a.md', 'sources/a.md', 'wiki/a.md', 'wiki-cn/a.md'].map((path) => (
      <KnowledgeLevelLabel key={path} path={path} />
    )),
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
  expect(view.contractReads()).toEqual([{ path: KNOWLEDGE_LEVELS_PATH, generation: 7 }])
  window.dispatchEvent(new Event('focus'))
  await vi.waitFor(() => expect(view.contractReads()).toHaveLength(2))
  await view.unmount()
  window.dispatchEvent(new Event('focus'))
  expect(view.contractReads()).toHaveLength(2)
})

it('leaves ordinary graphs without a contract unclassified', async () => {
  const view = await renderLabels(<KnowledgeLevelLabel path="wiki/a.md" />, null)
  await vi.waitFor(() => expect(view.contractReads()).toHaveLength(1))
  await vi.waitFor(() => expect(view.queryClient.isFetching()).toBe(0))
  expect(view.container.textContent).toBe('')
})

it('shows only the level in a compact column, including translations', async () => {
  const view = await renderLabels(<KnowledgeLevelLabel path="wiki-cn/a.md" compact />)
  await expect.element(view.getByText('L4', { exact: true })).toBeVisible()
  expect(view.container.textContent).toBe('L4')
  await expect
    .element(view.getByText('L4', { exact: true }))
    .toHaveAttribute('title', expect.stringContaining('L4 · Wiki.'))
})

it('does not assign a level to paths outside the declared rules', async () => {
  const view = await renderLabels(<KnowledgeLevelLabel path="other/a.md" />)
  await vi.waitFor(() => expect(view.contractReads()).toHaveLength(1))
  await vi.waitFor(() => expect(view.queryClient.isFetching()).toBe(0))
  expect(view.container.textContent).toBe('')
})

it('shows unavailable without inventing a tier for an invalid contract', async () => {
  const view = await renderLabels(<KnowledgeLevelLabel path="wiki/a.md" />, '{"version":2}')
  await expect.element(view.getByLabelText('Knowledge level unavailable')).toBeVisible()
  expect(view.container.querySelector('[data-knowledge-level]')).toBeNull()
})

it('reloads sidecar changes on window focus even while the cached copy is fresh', async () => {
  const view = await renderLabels(<KnowledgeLevelLabel path="wiki/a.md" />)
  await expect.element(view.getByText('L4 · Wiki', { exact: true })).toBeVisible()
  view.noteFile.set(
    KNOWLEDGE_LEVELS_PATH,
    JSON.stringify({
      ...contract,
      levels: contract.levels.map((level) => {
        return level.level === 4 ? { ...level, label: 'Updated wiki' } : level
      }),
    }),
  )
  window.dispatchEvent(new Event('focus'))
  await expect.element(view.getByText('L4 · Updated wiki', { exact: true })).toBeVisible()
  expect(view.contractReads()).toHaveLength(2)
})
