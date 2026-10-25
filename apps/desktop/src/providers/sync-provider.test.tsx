import type { ReactElement } from 'react'
import { describe, expect, it, onTestFinished } from 'vitest'
import { page } from 'vitest/browser'
import { createTestCoreServices } from '@reflect/core/testing'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { useGitSync, useGitSyncContext } from './sync-provider.tsx'

function Probe(): ReactElement {
  const sync = useGitSync()
  const context = useGitSyncContext()
  async function syncNow(): Promise<void> {
    try {
      await sync.syncNow()
    } catch {
      // The probe only records the call.
    }
  }
  return (
    <button
      type="button"
      data-context={context === null ? 'none' : 'some'}
      onClick={() => void syncNow()}
    >
      {sync.state.phase}
    </button>
  )
}

describe('useGitSync', () => {
  it('publishes the graph backup state and passes actions through', async () => {
    const { gitSync } = await renderInApp(<Probe />, { sync: { phase: 'loading' } })

    gitSync?.setState({ phase: 'disconnected' })
    await page.getByRole('button', { name: 'disconnected' }).click()

    expect(gitSync?.calls()).toEqual([{ method: 'start' }, { method: 'syncNow' }])
  })

  it('reads loading, and no context, where the graph runs no backup', async () => {
    const app = createTestCoreServices({
      database: createWasmTestDatabaseService(),
      role: 'note-window',
    })
    await renderInApp(<Probe />, { app })

    const button = page.getByRole('button', { name: 'loading' })
    await expect.element(button).toHaveAttribute('data-context', 'none')
  })

  it('passes a change the watcher does not report through, and ignores it without a backup', async () => {
    function ChangedProbe(): ReactElement {
      const sync = useGitSync()
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
    await renderInApp(<ChangedProbe />, { app: noteWindow })
    await page.getByRole('button', { name: 'changed' }).last().click()
  })
})
