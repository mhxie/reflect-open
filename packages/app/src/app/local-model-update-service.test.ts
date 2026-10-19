import { describe, expect, it, vi } from 'vitest'
import type { LocalModelUpdateReport } from '@reflect/core'
import { createTestLocalTranscriptionService } from '@reflect/core/testing'
import { createTestOperationsService } from '../testing/operations.ts'
import { createLocalModelUpdateService } from './local-model-update-service.ts'
import { MIN_VISIBLE_MS } from './operations-service.ts'

const REVISION: LocalModelUpdateReport = {
  generations: [],
  revision: { etag: 'abc123', sizeBytes: 1_000_000 },
}

function setup(updates: LocalModelUpdateReport = REVISION) {
  const localTranscription = createTestLocalTranscriptionService({ updates })
  const operations = createTestOperationsService()
  const updatesService = createLocalModelUpdateService({ localTranscription, operations })
  return { localTranscription, operations, updates: updatesService }
}

describe('LocalModelUpdateService.check', () => {
  it('offers a newer revision as a toast with an Update action', async () => {
    const { operations, updates } = setup({
      generations: [],
      revision: { etag: 'abc123', sizeBytes: 1_624_555_275 },
    })
    const listener = vi.fn()
    updates.subscribe(listener)

    await updates.check('large-v3-turbo', false)

    expect(updates.getPending()).toEqual({
      model: 'large-v3-turbo',
      etag: 'abc123',
      sizeBytes: 1_624_555_275,
    })
    expect(listener).toHaveBeenCalled()
    expect(operations.findByLabel('Transcription model update')).toMatchObject({
      persistent: true,
      description: 'Whisper large-v3 turbo · 1.6 GB',
      action: { label: 'Update' },
    })
  })

  it('announces a newer model generation without offering it', async () => {
    const { operations, updates } = setup({ generations: ['v4'], revision: null })

    await updates.check('large-v3-turbo', true)

    expect(updates.getPending()).toBeNull()
    expect(operations.snapshot()).toMatchObject([
      {
        label: 'Whisper v4 is available',
        status: 'warning',
        persistent: true,
        message: 'Reflect will offer it once an app update adds it.',
      },
    ])
  })

  it('stays silent when the check fails', async () => {
    const { localTranscription, operations, updates } = setup()
    vi.spyOn(localTranscription, 'checkUpdates').mockRejectedValue(new Error('offline'))

    await updates.check('large-v3-turbo', false)

    expect(updates.getPending()).toBeNull()
    expect(operations.getAll()).toEqual([])
  })
})

describe('LocalModelUpdateService.install', () => {
  it('downloads the pending revision and ends the operation', async () => {
    const { localTranscription, operations, updates } = setup()
    const download = vi.spyOn(localTranscription, 'download')
    const unlisten = vi.fn()
    const onStatus = localTranscription.onStatus.bind(localTranscription)
    vi.spyOn(localTranscription, 'onStatus').mockImplementation((listener) => {
      const stop = onStatus(listener)
      return () => {
        unlisten()
        stop()
      }
    })
    await updates.check('large-v3-turbo', false)

    await updates.install()

    expect(download).toHaveBeenCalledWith('large-v3-turbo')
    expect(unlisten).toHaveBeenCalled()
    expect(updates.getPending()).toBeNull()
    // The offer went with the pending update; the download leaves the list once shown.
    expect(operations.findByLabel('Transcription model update')).toBeUndefined()
    await operations.clock.advance(MIN_VISIBLE_MS)
    expect(operations.getAll()).toEqual([])
    expect(operations.getHistory()).toMatchObject([{ label: 'Updating the transcription model' }])
  })

  it('reports the download progress of the updated model only', async () => {
    const { localTranscription, operations, updates } = setup()
    const download = Promise.withResolvers<{ status: 'ready' }>()
    vi.spyOn(localTranscription, 'download').mockReturnValue(download.promise)
    await updates.check('large-v3-turbo', false)

    const installed = updates.install()
    localTranscription.setStatus('large-v3-turbo', {
      status: 'downloading',
      progress: { downloaded: 250, total: 1000 },
    })
    localTranscription.setStatus('qwen3-asr-0.6b', {
      status: 'downloading',
      progress: { downloaded: 900, total: 1000 },
    })

    expect(operations.findByLabel('Updating the transcription model')).toMatchObject({
      background: true,
      progress: { done: 250, total: 1000 },
    })
    download.resolve({ status: 'ready' })
    await installed
  })

  it('fails the operation instead of leaving it running when the download fails', async () => {
    const { localTranscription, operations, updates } = setup()
    vi.spyOn(localTranscription, 'download').mockRejectedValue(new Error('offline'))
    await updates.check('large-v3-turbo', false)

    await expect(updates.install()).resolves.toBeUndefined()

    expect(operations.findByLabel('Updating the transcription model')).toMatchObject({
      status: 'failed',
      message: 'offline',
    })
  })

  it('does nothing without a pending update', async () => {
    const { localTranscription, operations, updates } = setup()
    const download = vi.spyOn(localTranscription, 'download')

    await updates.install()

    expect(download).not.toHaveBeenCalled()
    expect(operations.getAll()).toEqual([])
  })
})

describe('LocalModelUpdateService.skip and clear', () => {
  it('skips the pending revision upstream and withdraws its offer', async () => {
    const { localTranscription, operations, updates } = setup()
    const skipUpdate = vi.spyOn(localTranscription, 'skipUpdate')
    await updates.check('large-v3-turbo', false)

    await updates.skip()

    expect(skipUpdate).toHaveBeenCalledWith('abc123')
    expect(updates.getPending()).toBeNull()
    expect(operations.findByLabel('Transcription model update')).toBeUndefined()
  })

  it('clears the offer for a deleted or switched model', async () => {
    const { localTranscription, operations, updates } = setup()
    const skipUpdate = vi.spyOn(localTranscription, 'skipUpdate')
    await updates.check('large-v3-turbo', false)

    updates.clear()

    expect(updates.getPending()).toBeNull()
    expect(operations.findByLabel('Transcription model update')).toBeUndefined()
    expect(skipUpdate).not.toHaveBeenCalled()
  })
})
