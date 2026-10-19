import { z } from 'zod'
import type { IpcBridgeService } from '../ipc/ipc-service.ts'

/**
 * The native shell's "user-initiated work" activity.
 */
export interface NativeActivityService {
  /**
   * Run `work` while the native shell holds a "user-initiated work" activity.
   * On macOS that keeps App Nap from throttling the process while every
   * window is hidden: napped, an embedding pass after a model switch runs
   * several times slower. Elsewhere it is inert. An activity that can't begin
   * never blocks the work, and the activity ends however the work settles.
   */
  run<T>(reason: string, work: () => Promise<T>): Promise<T>
}

const activityTokenSchema = z.string()
const voidSchema = z.null()

export interface NativeActivityServiceDeps {
  readonly ipc: IpcBridgeService
}

class NativeActivityServiceImpl implements NativeActivityService {
  readonly #deps: NativeActivityServiceDeps

  constructor(deps: NativeActivityServiceDeps) {
    this.#deps = deps
  }

  async run<T>(reason: string, work: () => Promise<T>): Promise<T> {
    const { ipc } = this.#deps
    let token: string | null = null
    try {
      token = await ipc.call('activity_begin', { reason }, activityTokenSchema)
    } catch {
      // No native shell to ask (a browser preview): the work runs unassisted.
    }
    try {
      return await work()
    } finally {
      if (token !== null) {
        await ipc.call('activity_end', { token }, voidSchema).catch(() => {})
      }
    }
  }
}

/**
 * The native activity over the `activity_begin` / `activity_end` commands.
 */
export function createNativeActivityService(
  deps: NativeActivityServiceDeps,
): NativeActivityService {
  return new NativeActivityServiceImpl(deps)
}
