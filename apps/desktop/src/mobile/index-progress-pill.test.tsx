import { createTestAppServices } from '@reflect/app/testing'
import type { IndexFileProgress } from '@reflect/core'
import { createTestCoreServices, type TestCoreServices } from '@reflect/core/testing'
import { describe, expect, it } from 'vitest'
import { renderInApp, type InAppRenderResult } from '@/test-utils/render-in-app.tsx'
import { IndexProgressPill } from './index-progress-pill.tsx'

/**
 * The "Preparing notes…" pill gates on the pass doing real work (`worked` =
 * files actually read), not on graph size: a reconcile sweeps the whole
 * listing on every open and resume, so `done`/`total` alone would show the
 * pill every single time even when everything skips read-free.
 */

/**
 * Render the pill over a running pass at `progress`, with the keyboard at `keyboardInset`.
 */
async function mount(
  progress: IndexFileProgress,
  keyboardInset = 0,
): Promise<InAppRenderResult<TestCoreServices>> {
  const app = createTestCoreServices()
  app.indexLifecycle.setFileProgress(progress)
  const appServices = createTestAppServices(app)
  appServices.keyboard.publish(keyboardInset)
  return await renderInApp(<IndexProgressPill />, { app, appServices })
}

describe('IndexProgressPill', () => {
  it('stays hidden for a skip-everything pass, however large the graph', async () => {
    const view = await mount({ done: 3_500, total: 7_000, worked: 0 })
    expect(view.getByRole('status').query()).toBeNull()
  })

  it('appears once a pass has actually read enough files (a first index)', async () => {
    const view = await mount({ done: 160, total: 7_000, worked: 160 })
    await expect.element(view.getByRole('status')).toMatchTextContent('160 of 7,000')
  })

  it('stays hidden below the work threshold — a routine sync of a few notes', async () => {
    const view = await mount({ done: 6_900, total: 7_000, worked: 40 })
    expect(view.getByRole('status').query()).toBeNull()
  })

  it('stays hidden on a small graph even when every file is read', async () => {
    const view = await mount({ done: 90, total: 90, worked: 90 })
    expect(view.getByRole('status').query()).toBeNull()
  })

  it('yields to the keyboard', async () => {
    const view = await mount({ done: 500, total: 7_000, worked: 500 }, 300)
    expect(view.getByRole('status').query()).toBeNull()
  })
})
