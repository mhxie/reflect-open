import { afterEach, describe, expect, it } from 'vitest'
import { setBridge } from '../ipc/bridge.ts'
import { withActivity } from './activity.ts'

/** A bridge that grants activities (or refuses them) and records the calls. */
function fakeShell(grant: boolean): Array<[string, unknown]> {
  const calls: Array<[string, unknown]> = []
  setBridge({
    invoke: async (command, args) => {
      calls.push([command, args])
      if (command === 'activity_begin') {
        if (!grant) {
          throw { kind: 'unknown', message: 'unimplemented command' }
        }
        return 'activity-1'
      }
      return null
    },
    listen: async () => () => {},
  })
  return calls
}

describe('withActivity', () => {
  afterEach(() => {
    setBridge(null)
  })

  it('holds an activity for exactly the duration of the work', async () => {
    const calls = fakeShell(true)
    const result = await withActivity('Embedding notes', async () => {
      expect(calls.map(([command]) => command)).toEqual(['activity_begin'])
      return 42
    })
    expect(result).toBe(42)
    expect(calls).toEqual([
      ['activity_begin', { reason: 'Embedding notes' }],
      ['activity_end', { token: 'activity-1' }],
    ])
  })

  it('ends the activity when the work fails, and rethrows', async () => {
    const calls = fakeShell(true)
    await expect(
      withActivity('Embedding notes', async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(calls.at(-1)).toEqual(['activity_end', { token: 'activity-1' }])
  })

  it('runs the work unassisted when no activity can begin', async () => {
    const calls = fakeShell(false)
    expect(await withActivity('Embedding notes', async () => 'done')).toBe('done')
    expect(calls.map(([command]) => command)).toEqual(['activity_begin'])
  })
})
