import { beforeEach, describe, expect, it, vi } from 'vitest'

const core = vi.hoisted(() => ({
  checkLocalModelUpdates: vi.fn(),
  downloadLocalModel: vi.fn(),
  skipLocalModelUpdate: vi.fn(),
  subscribeLocalModelStatus: vi.fn(),
}))
const operation = vi.hoisted(() => ({
  progress: vi.fn(),
  done: vi.fn(),
  warn: vi.fn(),
  fail: vi.fn(),
  dismiss: vi.fn(),
}))

vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  ...core,
}))
vi.mock('@/lib/operations.ts', () => ({ startOperation: () => operation }))

const { checkForLocalModelUpdates, installLocalModelUpdate } =
  await import('./local-model-updates.ts')

beforeEach(async () => {
  vi.clearAllMocks()
  core.checkLocalModelUpdates.mockResolvedValue({
    generations: [],
    revision: { etag: 'abc123', sizeBytes: 1_000_000 },
  })
  await checkForLocalModelUpdates('large-v3-turbo', false)
})

describe('installLocalModelUpdate', () => {
  it('downloads the pending revision and ends the operation', async () => {
    const unlisten = vi.fn()
    core.subscribeLocalModelStatus.mockResolvedValue(unlisten)
    core.downloadLocalModel.mockResolvedValue({ status: 'ready' })

    await installLocalModelUpdate()

    expect(core.downloadLocalModel).toHaveBeenCalledWith('large-v3-turbo')
    expect(operation.done).toHaveBeenCalled()
    expect(unlisten).toHaveBeenCalled()
  })

  it('fails the operation instead of leaving it running when progress cannot be followed', async () => {
    core.subscribeLocalModelStatus.mockRejectedValue(new Error('no event bridge'))

    await expect(installLocalModelUpdate()).resolves.toBeUndefined()

    expect(operation.fail).toHaveBeenCalledWith('no event bridge')
    expect(core.downloadLocalModel).not.toHaveBeenCalled()
  })
})
