import { render } from 'vitest-browser-react'
import { page, userEvent } from 'vitest/browser'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '@reflect/core'
import exampleReport from '../../../../../fixtures/wiki-trust-report.example.json'
import { WikiTrustDisplayField } from './wiki-trust-display-field.tsx'
import { WikiTrustReportField } from './wiki-trust-report-field.tsx'

const settingsState = vi.hoisted(() => ({
  settings: {
    wikiTrustDisplay: 'inline',
    wikiTrustReportPath: '.harness/wiki-trust.json',
    timeFormat: '24h',
    dateFormat: 'iso',
  },
  updates: [] as Record<string, unknown>[],
}))
vi.mock('@/providers/settings-provider.tsx', () => ({
  useSettings: () => ({
    settings: settingsState.settings,
    updateSettings: (patch: Record<string, unknown>) => {
      settingsState.updates.push(patch)
    },
  }),
}))
vi.mock('@/providers/graph-provider.tsx', () => ({
  useGraph: () => ({ graph: { root: '/graphs/Personal', name: 'Personal', generation: 3 } }),
}))

let report: { stamp: string; contents: string } | null
let reads: Record<string, unknown>[]
let queryClient: QueryClient

beforeEach(() => {
  settingsState.updates = []
  reads = []
  report = null
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  setBridge({
    invoke: async (command, args) => {
      if (command !== 'wiki_trust_report_read') throw new Error(`unexpected command ${command}`)
      reads.push(args ?? {})
      return report
    },
    listen: async () => () => {},
  })
})

afterEach(() => {
  queryClient.clear()
})

async function renderFields(): Promise<void> {
  await render(
    <QueryClientProvider client={queryClient}>
      <WikiTrustDisplayField />
      <WikiTrustReportField />
    </QueryClientProvider>,
  )
}

describe('Settings → Wiki trust', () => {
  it('summarizes the report the harness wrote', async () => {
    report = { stamp: '1:1', contents: JSON.stringify(exampleReport) }
    await renderFields()
    await expect
      .element(page.getByText(/example-harness 1\.0\.0 · written .* · 2 claims in 1 note/))
      .toBeVisible()
    expect(reads[0]).toEqual({
      path: '.harness/wiki-trust.json',
      knownStamp: null,
      generation: 3,
    })
  })

  it('says when no report exists yet', async () => {
    await renderFields()
    await expect.element(page.getByText(/^No report yet\./)).toBeVisible()
  })

  it('names a report that does not validate', async () => {
    report = { stamp: '1:1', contents: JSON.stringify({ ...exampleReport, version: 9 }) }
    await renderFields()
    await expect
      .element(page.getByRole('alert'))
      .toHaveTextContent('The trust report does not match reflect-wiki-trust version 1 at version.')
  })

  it('commits a valid path and refuses one Reflect may not read', async () => {
    await renderFields()
    const input = page.getByLabelText('Trust report path')
    await input.fill('.reflect/trust.json')
    await userEvent.keyboard('{Enter}')
    await expect.element(page.getByText(/outside \.reflect\/ and \.git\//)).toBeVisible()
    expect(settingsState.updates).toEqual([])
    await input.fill(' ./_meta/wiki-trust.json ')
    await userEvent.keyboard('{Enter}')
    expect(settingsState.updates).toEqual([{ wikiTrustReportPath: '_meta/wiki-trust.json' }])
  })

  it('switches the reading style', async () => {
    await renderFields()
    await page.getByText('Beside the paragraph').click()
    expect(settingsState.updates).toEqual([{ wikiTrustDisplay: 'margin' }])
  })
})
