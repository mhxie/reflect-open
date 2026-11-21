import type { ReactElement } from 'react'
import { describe, expect, it, onTestFinished } from 'vitest'
import { page } from 'vitest/browser'
import { createTestCoreServices } from '@reflect/core/testing'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { useGitSyncActions, useGitSyncState } from './sync-provider.tsx'

function Probe(): ReactElement {
  const state = useGitSyncState()
  const actions = useGitSyncActions()
  async function syncNow(): Promise<void> {
    try {
      await actions.syncNow()
    } catch {
      // The probe only records the call.
    }
  }
  return (
    <button type="button" onClick={() => void syncNow()}>
      {state.phase}
    </button>
  )
}

describe('useGitSyncState', () => {
  it('publishes the graph backup state and passes actions through', async () => {
    const { gitSync } = await renderInApp(<Probe />, { sync: { phase: 'loading' } })

    gitSync?.setState({ phase: 'disconnected' })
    await page.getByRole('button', { name: 'disconnected' }).click()

    expect(gitSync?.calls()).toEqual([{ method: 'start' }, { method: 'syncNow' }])
  })

  it('reads loading where the graph runs no backup', async () => {
    const core = createTestCoreServices({
      database: createWasmTestDatabaseService(),
      role: 'note-window',
    })
    await renderInApp(<Probe />, { core })

    await expect.element(page.getByRole('button', { name: 'loading' })).toBeInTheDocument()
  })

  it('passes a change the watcher does not report through, and ignores it without a backup', async () => {
    function ChangedProbe(): ReactElement {
      const sync = useGitSyncActions()
      return (
        <button type="button" onClick={() => sync.fileChanged()}>
          changed
        </button>
      )
    }
    const { gitSync } = await renderInApp(<ChangedProbe />, { sync: { phase: 'loading' } })
    await page.getByRole('button', { name: 'changed' }).click()
    expect(gitSync?.calls()).toEqual([{ method: 'start' }, { method: 'fileChanged' }])

    // A note window runs no backup: the same call is a no-op, not a throw.
    const noteWindow = createTestCoreServices({
      database: createWasmTestDatabaseService(),
      role: 'note-window',
    })
    onTestFinished(() => noteWindow.database.close())
    await renderInApp(<ChangedProbe />, { core: noteWindow })
    await page.getByRole('button', { name: 'changed' }).last().click()
  })
})
