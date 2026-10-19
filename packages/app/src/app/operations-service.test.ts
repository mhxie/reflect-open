import { describe, expect, it } from 'vitest'
import { createTestOperationsService } from '../testing/operations.ts'
import { LINGER_MS, MIN_VISIBLE_MS } from './operations-service.ts'

describe('createOperationsService', () => {
  it('tracks start, progress, and done', async () => {
    const operations = createTestOperationsService()
    expect(operations.getAll()).toEqual([])

    const handle = operations.start('Renaming "A" to "B"')
    expect(operations.getAll()).toHaveLength(1)
    expect(operations.getAll()[0]!.label).toBe('Renaming "A" to "B"')
    expect(operations.getAll()[0]!.progress).toBeNull()

    handle.progress(3, 12)
    expect(operations.getAll()[0]!.progress).toEqual({ done: 3, total: 12 })

    handle.done()
    expect(operations.getAll()).toHaveLength(1)
    await operations.clock.advance(MIN_VISIBLE_MS - 1)
    expect(operations.getAll()).toHaveLength(1)
    await operations.clock.advance(1)
    expect(operations.getAll()).toEqual([])
  })

  it('removes a finished operation at once after the minimum visible time', async () => {
    const operations = createTestOperationsService()
    const handle = operations.start('slow')
    await operations.clock.advance(MIN_VISIBLE_MS)
    handle.done()
    expect(operations.getAll()).toEqual([])
    expect(operations.clock.pendingTimers()).toBe(0)
  })

  it('keeps a failed operation with its error, then clears it', async () => {
    const operations = createTestOperationsService()
    const handle = operations.start('Renaming')
    handle.fail('disk full')
    expect(operations.findByLabel('Renaming')).toMatchObject({
      status: 'failed',
      message: 'disk full',
    })

    await operations.clock.advance(LINGER_MS + MIN_VISIBLE_MS - 1)
    expect(operations.getAll()).toHaveLength(1)
    await operations.clock.advance(1)
    expect(operations.getAll()).toEqual([])
  })

  it('keeps a warning operation without marking it failed', async () => {
    const operations = createTestOperationsService()
    const handle = operations.start('Rebuilding search index')
    handle.warn('Rebuilt with 1 skipped note: notes/bad.md')
    expect(operations.snapshot()).toEqual([
      {
        label: 'Rebuilding search index',
        description: null,
        progress: null,
        status: 'warning',
        persistent: false,
        background: false,
        action: null,
        message: 'Rebuilt with 1 skipped note: notes/bad.md',
      },
    ])

    await operations.clock.advance(LINGER_MS + MIN_VISIBLE_MS)
    expect(operations.getAll()).toEqual([])
  })

  it('scopes handles: finishing one operation leaves others running', async () => {
    const operations = createTestOperationsService()
    const first = operations.start('first')
    operations.start('second')
    first.done()
    await operations.clock.advance(MIN_VISIBLE_MS)
    expect(operations.getAll().map((operation) => operation.label)).toEqual(['second'])
  })

  it('stores optional metadata and can dismiss immediately', async () => {
    const operations = createTestOperationsService()
    const action = { label: 'Install', run: () => {} }
    const handle = operations.start('Install update', {
      description: 'Reflect 1.2.3 is ready.',
      persistent: true,
      action,
    })
    expect(operations.getAll()[0]).toMatchObject({
      label: 'Install update',
      description: 'Reflect 1.2.3 is ready.',
      persistent: true,
      action,
    })

    await operations.clock.advance(30_000)
    expect(operations.getAll()).toHaveLength(1)

    handle.dismiss()
    expect(operations.getAll()).toEqual([])
  })

  it('keeps persistent failures visible until dismissed by id', async () => {
    const operations = createTestOperationsService()
    const handle = operations.start('Install update', { persistent: true })
    handle.fail('signature failed')
    await operations.clock.advance(30_000)
    const failed = operations.findByLabel('Install update')
    expect(failed).toMatchObject({ status: 'failed', message: 'signature failed' })

    operations.dismiss(failed!.id)
    expect(operations.getAll()).toEqual([])
  })

  it('notifies listeners on every change until they unsubscribe', () => {
    const operations = createTestOperationsService()
    let calls = 0
    const unlisten = operations.subscribe(() => {
      calls++
    })
    const handle = operations.start('job')
    handle.progress(1, 2)
    expect(calls).toBe(2)
    const before = operations.getAll()
    unlisten()
    handle.dismiss()
    expect(calls).toBe(2)
    expect(operations.getAll()).not.toBe(before)
  })

  it('ignores changes to an operation that is gone', () => {
    const operations = createTestOperationsService()
    const handle = operations.start('job')
    handle.dismiss()
    let calls = 0
    operations.subscribe(() => {
      calls++
    })
    handle.progress(1, 2)
    operations.dismiss(999)
    expect(calls).toBe(0)
  })

  it('keeps finished background operations in the history, newest first', async () => {
    const operations = createTestOperationsService()
    const describing = operations.start('Describing assets', { background: true })
    operations.start('Saving').done()
    expect(operations.getAll()[0]).toMatchObject({ label: 'Describing assets', background: true })

    await operations.clock.advance(MIN_VISIBLE_MS)
    expect(operations.getHistory()).toEqual([])
    describing.done()
    const rebuilding = operations.start('Rebuilding search index', { background: true })
    await operations.clock.advance(5)
    rebuilding.fail('disk full')
    await operations.clock.advance(LINGER_MS + MIN_VISIBLE_MS)

    expect(operations.getAll()).toEqual([])
    // Each entry ends when its handle removes it: at once for a done after the
    // minimum visible time, after the linger for a failure.
    expect(operations.getHistory()).toEqual([
      {
        id: 3,
        label: 'Rebuilding search index',
        status: 'failed',
        message: 'disk full',
        endedAt: MIN_VISIBLE_MS + MIN_VISIBLE_MS + LINGER_MS,
      },
      {
        id: 1,
        label: 'Describing assets',
        status: 'running',
        message: null,
        endedAt: MIN_VISIBLE_MS,
      },
    ])
  })

  it('keeps the eight newest finished background operations', () => {
    const operations = createTestOperationsService()
    for (let index = 1; index <= 10; index++) {
      operations.start(`job ${index}`, { background: true }).dismiss()
    }
    expect(operations.getHistory().map((finished) => finished.label)).toEqual([
      'job 10',
      'job 9',
      'job 8',
      'job 7',
      'job 6',
      'job 5',
      'job 4',
      'job 3',
    ])
  })
})
