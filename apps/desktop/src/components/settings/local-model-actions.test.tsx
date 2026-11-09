import { createTestCoreServices } from '@reflect/core/testing'
import { createTestAppServices } from '@reflect/app/testing'
import { page } from 'vitest/browser'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { LocalModelStatus, LocalTranscriptionModelId } from '@reflect/core'
import type { PendingLocalModelUpdate } from '@reflect/app'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { LocalModelActions } from './local-model-actions.tsx'

/**
 * Render the actions over a scripted transcription service and update
 * offer; returns the spies the buttons drive.
 */
async function renderActions(
  model: LocalTranscriptionModelId,
  status: LocalModelStatus,
  pending: PendingLocalModelUpdate | null = null,
) {
  const app = createTestCoreServices({ database: createWasmTestDatabaseService() })
  onTestFinished(() => app.database.close())
  const appServices = createTestAppServices(app)
  const download = vi
    .spyOn(app.localTranscription, 'download')
    .mockResolvedValue({ status: 'downloading', progress: { downloaded: 0, total: 1 } })
  const remove = vi.spyOn(app.localTranscription, 'delete').mockResolvedValue({ status: 'missing' })
  const updates = appServices.localModelUpdates
  vi.spyOn(updates, 'getPending').mockReturnValue(pending)
  const install = vi.spyOn(updates, 'install').mockResolvedValue(undefined)
  const skip = vi.spyOn(updates, 'skip').mockResolvedValue(undefined)
  const clear = vi.spyOn(updates, 'clear').mockImplementation(() => {})
  await renderInApp(<LocalModelActions model={model} status={status} />, { core: app, appServices })
  return { download, remove, install, skip, clear }
}

describe('LocalModelActions', () => {
  it('offers the download at the model’s size', async () => {
    const { download } = await renderActions('large-v3-turbo', { status: 'missing' })

    await page.getByRole('button', { name: 'Download (1.6 GB)' }).click()

    expect(download).toHaveBeenCalledWith('large-v3-turbo')
  })

  it('tracks a running download as a progress bar', async () => {
    await renderActions('large-v3-turbo-q5_0', {
      status: 'downloading',
      progress: { downloaded: 287_020_597, total: 574_041_195 },
    })

    await expect
      .element(page.getByRole('progressbar', { name: 'Transcription model download' }))
      .toHaveAttribute('aria-valuenow', '50')
  })

  it('reports a failed first download and retries it', async () => {
    const { download } = await renderActions('large-v3-turbo', {
      status: 'failed',
      message: 'offline',
    })

    await expect.element(page.getByText('Couldn’t download the model: offline')).toBeVisible()
    await page.getByRole('button', { name: 'Try again' }).click()
    expect(download).toHaveBeenCalledWith('large-v3-turbo')
  })

  it('deletes a downloaded model and withdraws any pending update offer', async () => {
    const { remove, clear } = await renderActions('large-v3-turbo', { status: 'ready' })

    await page.getByRole('button', { name: 'Delete' }).click()

    expect(clear).toHaveBeenCalled()
    expect(remove).toHaveBeenCalledWith('large-v3-turbo')
  })

  it('offers newer weights for the downloaded model, to install or skip', async () => {
    const { install, skip } = await renderActions(
      'large-v3-turbo',
      { status: 'ready' },
      { model: 'large-v3-turbo', etag: 'abc', sizeBytes: 1_624_555_275 },
    )

    await expect.element(page.getByText('Newer weights are available (1.6 GB).')).toBeVisible()
    await page.getByRole('button', { name: 'Update' }).click()
    expect(install).toHaveBeenCalled()
    await page.getByRole('button', { name: 'Skip this version' }).click()
    expect(skip).toHaveBeenCalled()
  })

  it('ignores an update offer that belongs to another model', async () => {
    await renderActions(
      'large-v3-turbo',
      { status: 'ready' },
      { model: 'large-v3-q5_0', etag: 'abc', sizeBytes: 1 },
    )

    await expect.element(page.getByRole('button', { name: 'Delete' })).toBeVisible()
    expect(page.getByRole('button', { name: 'Update' }).elements()).toHaveLength(0)
  })
})
