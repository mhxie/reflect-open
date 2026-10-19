import { describe, expect, it } from 'vitest'
import { ReflectError } from '../errors.ts'
import { createTestIpcBridgeService } from '../testing/ipc.ts'
import { createNativeActivityService } from './native-activity-service.ts'

/**
 * A shell that grants activities (or refuses them); the double records the calls.
 */
function fakeShell(grant: boolean) {
  const ipc = createTestIpcBridgeService({
    commands: {
      activity_begin: () => {
        if (!grant) {
          throw new ReflectError('unknown', 'unimplemented command')
        }
        return 'activity-1'
      },
      activity_end: () => null,
    },
  })
  return { ipc, activity: createNativeActivityService({ ipc }) }
}

describe('NativeActivityService.run', () => {
  it('holds an activity for exactly the duration of the work', async () => {
    const { ipc, activity } = fakeShell(true)
    const result = await activity.run('Embedding notes', async () => {
      expect(ipc.calls().map((call) => call.command)).toEqual(['activity_begin'])
      return 42
    })
    expect(result).toBe(42)
    expect(ipc.calls()).toEqual([
      { command: 'activity_begin', args: { reason: 'Embedding notes' } },
      { command: 'activity_end', args: { token: 'activity-1' } },
    ])
  })

  it('ends the activity when the work fails, and rethrows', async () => {
    const { ipc, activity } = fakeShell(true)
    await expect(
      activity.run('Embedding notes', async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(ipc.calls().at(-1)).toEqual({
      command: 'activity_end',
      args: { token: 'activity-1' },
    })
  })

  it('runs the work unassisted when no activity can begin', async () => {
    const { ipc, activity } = fakeShell(false)
    expect(await activity.run('Embedding notes', async () => 'done')).toBe('done')
    expect(ipc.calls().map((call) => call.command)).toEqual(['activity_begin'])
  })
})
