import { z } from 'zod'
import { call } from '../ipc/invoke.ts'

/**
 * Run `work` while the native shell holds a "user-initiated work" activity.
 * On macOS that keeps App Nap from throttling the process while every window
 * is hidden: napped, an embedding pass after a model switch runs several times
 * slower. Elsewhere it is inert. An activity that can't begin never blocks
 * the work.
 */
export async function withActivity<T>(reason: string, work: () => Promise<T>): Promise<T> {
  let token: string | null = null
  try {
    token = await call('activity_begin', { reason }, z.string())
  } catch {
    // No native shell to ask (a browser preview): the work runs unassisted.
  }
  try {
    return await work()
  } finally {
    if (token !== null) {
      await call('activity_end', { token }, z.null()).catch(() => {})
    }
  }
}
