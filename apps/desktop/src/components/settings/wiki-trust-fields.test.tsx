import { createTestCoreServices } from '@reflect/core/testing'
import { page, userEvent } from 'vitest/browser'
import { describe, expect, it, onTestFinished, vi, type MockInstance } from 'vitest'
import type { Settings } from '@reflect/core'
import exampleReport from '../../../../../fixtures/wiki-trust-report.example.json'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { WikiTrustDisplayField } from './wiki-trust-display-field.tsx'
import { WikiTrustReportField } from './wiki-trust-report-field.tsx'

/** What `wiki_trust_report_read` answers, and the reads it saw. */
let report: { stamp: string; contents: string } | null = null
let reads: Record<string, unknown>[] = []
let updates: MockInstance<(patch: Partial<Settings>) => void>

/** The settings patches the fields wrote, in order. */
function written(): Partial<Settings>[] {
  return updates.mock.calls.map(([patch]) => patch)
}

async function renderFields(): Promise<void> {
  reads = []
  const app = createTestCoreServices({ database: createWasmTestDatabaseService() })
  onTestFinished(() => app.database.close())
  app.ipc.onCommand('wiki_trust_report_read', (args) => {
    reads.push(args)
    return report
  })
  updates = vi.spyOn(app.settings, 'update')
  await renderInApp(
    <>
      <WikiTrustDisplayField />
      <WikiTrustReportField />
    </>,
    {
      core: app,
      graph: { root: '/graphs/Personal', name: 'Personal', generation: 3 },
      settings: {
        wikiTrustDisplay: 'inline',
        wikiTrustReportPath: '.harness/wiki-trust.json',
        timeFormat: '24h',
        dateFormat: 'iso',
      },
    },
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
    report = null
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
    report = null
    await renderFields()
    const input = page.getByLabelText('Trust report path')
    await input.fill('.reflect/trust.json')
    await userEvent.keyboard('{Enter}')
    await expect.element(page.getByText(/outside \.reflect\/ and \.git\//)).toBeVisible()
    expect(written()).toEqual([])
    await input.fill(' ./_meta/wiki-trust.json ')
    await userEvent.keyboard('{Enter}')
    expect(written()).toEqual([{ wikiTrustReportPath: '_meta/wiki-trust.json' }])
  })

  it('switches the reading style', async () => {
    report = null
    await renderFields()
    await page.getByText('Beside the paragraph').click()
    expect(written()).toEqual([{ wikiTrustDisplay: 'margin' }])
  })
})
