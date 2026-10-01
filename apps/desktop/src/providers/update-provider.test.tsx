import { useEffect, type ReactElement } from 'react'
import { render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UpdateController } from '@/lib/update-controller.ts'

const controller = vi.hoisted((): UpdateController => {
  // A stable snapshot, as useSyncExternalStore requires.
  const idle = { phase: 'idle' } as const
  return {
    subscribe: () => () => {},
    getState: () => idle,
    start: vi.fn(),
    dispose: vi.fn(),
    checkNow: vi.fn(async () => {}),
    install: vi.fn(async () => {}),
    restart: vi.fn(async () => {}),
  }
})
const createUpdateController = vi.hoisted(() => vi.fn(() => controller))
vi.mock('@/lib/platform.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform.ts')>()),
  isNativeShell: () => true,
}))
vi.mock('@/lib/update-controller.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/update-controller.ts')>()),
  createUpdateController,
}))
vi.mock('@/components/update-toasts.ts', () => ({ attachUpdateToasts: () => () => {} }))
vi.mock('@/hooks/use-main-window-effect.ts', () => ({ useMainWindowEffect: useEffect }))

const { UpdateProvider, useUpdate } = await import('./update-provider.tsx')

function Supported(): ReactElement {
  return <p>{useUpdate().supported ? 'updates on' : 'updates off'}</p>
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('UpdateProvider', () => {
  it('checks the release feed from a packaged desktop build', async () => {
    await render(
      <UpdateProvider autoCheck>
        <Supported />
      </UpdateProvider>,
    )

    await expect.element(page.getByText('updates on')).toBeVisible()
    expect(createUpdateController).toHaveBeenCalledWith({ autoCheck: true })
  })

  it('never checks or offers updates in a local build', async () => {
    vi.stubEnv('VITE_UPDATES', 'off')
    await render(
      <UpdateProvider autoCheck>
        <Supported />
      </UpdateProvider>,
    )

    await expect.element(page.getByText('updates off')).toBeVisible()
    expect(createUpdateController).not.toHaveBeenCalled()
  })
})
