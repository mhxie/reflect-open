import { render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PendingLocalModelUpdate } from '@/lib/local-model-updates.ts'

const core = vi.hoisted(() => ({
  downloadLocalModel: vi.fn(),
  deleteLocalModel: vi.fn(),
}))
const updates = vi.hoisted(() => ({
  pending: null as PendingLocalModelUpdate | null,
  installLocalModelUpdate: vi.fn(),
  skipPendingLocalModelUpdate: vi.fn(),
  clearPendingLocalModelUpdate: vi.fn(),
}))
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  downloadLocalModel: core.downloadLocalModel,
  deleteLocalModel: core.deleteLocalModel,
}))
vi.mock('@/lib/local-model-updates.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/local-model-updates.ts')>()),
  usePendingLocalModelUpdate: () => updates.pending,
  installLocalModelUpdate: updates.installLocalModelUpdate,
  skipPendingLocalModelUpdate: updates.skipPendingLocalModelUpdate,
  clearPendingLocalModelUpdate: updates.clearPendingLocalModelUpdate,
}))

const { LocalModelActions } = await import('./local-model-actions.tsx')

beforeEach(() => {
  vi.clearAllMocks()
  updates.pending = null
  core.downloadLocalModel.mockResolvedValue({ status: 'downloading' })
  core.deleteLocalModel.mockResolvedValue({ status: 'missing' })
  updates.installLocalModelUpdate.mockResolvedValue(undefined)
  updates.skipPendingLocalModelUpdate.mockResolvedValue(undefined)
})

describe('LocalModelActions', () => {
  it('offers the download at the model’s size', async () => {
    await render(<LocalModelActions model="large-v3-turbo" status={{ status: 'missing' }} />)

    await page.getByRole('button', { name: 'Download (1.6 GB)' }).click()

    expect(core.downloadLocalModel).toHaveBeenCalledWith('large-v3-turbo')
  })

  it('tracks a running download as a progress bar', async () => {
    await render(
      <LocalModelActions
        model="large-v3-turbo-q5_0"
        status={{
          status: 'downloading',
          progress: { downloaded: 287_020_597, total: 574_041_195 },
        }}
      />,
    )

    await expect
      .element(page.getByRole('progressbar', { name: 'Transcription model download' }))
      .toHaveAttribute('aria-valuenow', '50')
  })

  it('reports a failed first download and retries it', async () => {
    await render(
      <LocalModelActions
        model="large-v3-turbo"
        status={{ status: 'failed', message: 'offline' }}
      />,
    )

    await expect.element(page.getByText('Couldn’t download the model: offline')).toBeVisible()
    await page.getByRole('button', { name: 'Try again' }).click()
    expect(core.downloadLocalModel).toHaveBeenCalledWith('large-v3-turbo')
  })

  it('deletes a downloaded model and withdraws any pending update offer', async () => {
    await render(<LocalModelActions model="large-v3-turbo" status={{ status: 'ready' }} />)

    await page.getByRole('button', { name: 'Delete' }).click()

    expect(updates.clearPendingLocalModelUpdate).toHaveBeenCalled()
    expect(core.deleteLocalModel).toHaveBeenCalledWith('large-v3-turbo')
  })

  it('offers newer weights for the downloaded model, to install or skip', async () => {
    updates.pending = { model: 'large-v3-turbo', etag: 'abc', sizeBytes: 1_624_555_275 }
    await render(<LocalModelActions model="large-v3-turbo" status={{ status: 'ready' }} />)

    await expect.element(page.getByText('Newer weights are available (1.6 GB).')).toBeVisible()
    await page.getByRole('button', { name: 'Update' }).click()
    expect(updates.installLocalModelUpdate).toHaveBeenCalled()
    await page.getByRole('button', { name: 'Skip this version' }).click()
    expect(updates.skipPendingLocalModelUpdate).toHaveBeenCalled()
  })

  it('ignores an update offer that belongs to another model', async () => {
    updates.pending = { model: 'large-v3-q5_0', etag: 'abc', sizeBytes: 1 }
    await render(<LocalModelActions model="large-v3-turbo" status={{ status: 'ready' }} />)

    await expect.element(page.getByRole('button', { name: 'Delete' })).toBeVisible()
    expect(page.getByRole('button', { name: 'Update' }).elements()).toHaveLength(0)
  })
})
