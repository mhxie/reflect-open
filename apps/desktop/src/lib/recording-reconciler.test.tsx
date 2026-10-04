import { afterEach, describe, expect, it, vi } from 'vitest'

const reconcileRecordings = vi.hoisted(() => vi.fn())
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  reconcileRecordings,
  subscribeRecorderFinished: async () => () => {},
}))

const { createRecordingReconciler } = await import('./recording-reconciler.ts')

let dispose: () => void = () => {}

afterEach(() => {
  dispose()
  reconcileRecordings.mockReset()
})

function start(onWritten: (paths: readonly string[]) => void) {
  const reconciler = createRecordingReconciler({
    generation: 1,
    graphRoot: '/g',
    getSettings: async () => ({}) as never,
    onWritten,
  })
  dispose = reconciler.dispose
  reconciler.start()
}

describe('createRecordingReconciler', () => {
  it('reports the transcript notes a pass wrote', async () => {
    reconcileRecordings.mockResolvedValue({ written: ['recordings/call.md'], stopped: null })
    const onWritten = vi.fn()
    start(onWritten)

    await vi.waitFor(() => expect(onWritten).toHaveBeenCalledWith(['recordings/call.md']))
  })

  it('stays quiet when a pass wrote nothing', async () => {
    reconcileRecordings.mockResolvedValue({ written: [], stopped: null })
    const onWritten = vi.fn()
    start(onWritten)

    await vi.waitFor(() => expect(reconcileRecordings).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(onWritten).not.toHaveBeenCalled()
  })
})
