import type { ReactElement } from 'react'
import { page } from 'vitest/browser'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { createAppServices } from '@reflect/app'
import { createTestAppHost, createTestUpdateService } from '@reflect/app/testing'
import { createTestCoreServices } from '@reflect/core/testing'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { UpdateProvider, useUpdate } from './update-provider.tsx'

function Supported(): ReactElement {
  return <p>{useUpdate().supported ? 'updates on' : 'updates off'}</p>
}

describe('UpdateProvider', () => {
  it('checks the release feed from a packaged desktop build', async () => {
    const update = createTestUpdateService()
    await renderInApp(
      <UpdateProvider autoCheck>
        <Supported />
      </UpdateProvider>,
      { appServices: { update }, route: null },
    )

    await expect.element(page.getByText('updates on')).toBeVisible()
    expect(update.calls).toContain('start')
  })

  it('never checks or offers updates in a local build', async () => {
    // A local build (`VITE_UPDATES=off`) gets no updater from the desktop
    // host (`createDesktopHost`), so its update service is unsupported.
    const app = createTestCoreServices({ database: createWasmTestDatabaseService() })
    onTestFinished(() => app.database.close())
    const { update } = createAppServices(app, createTestAppHost())
    const start = vi.spyOn(update, 'start')
    await renderInApp(
      <UpdateProvider autoCheck>
        <Supported />
      </UpdateProvider>,
      { app, appServices: { update }, route: null },
    )

    await expect.element(page.getByText('updates off')).toBeVisible()
    expect(start).not.toHaveBeenCalled()
  })
})
