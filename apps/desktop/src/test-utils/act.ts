import { act as reactAct } from 'react'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}

/**
 * React's `act` for browser tests. React only accepts `act` while
 * `IS_REACT_ACT_ENVIRONMENT` is set, and the flag cannot stay on: with it on,
 * every update from a real browser event warns that it was not wrapped in
 * `act`. So the flag is on for the duration of the scope only, the same rule
 * `vitest-browser-react` applies to its own `render`.
 *
 * Tests import this instead of `act` from `react`.
 */
export function act(callback: () => void): void {
  const previous = globalThis.IS_REACT_ACT_ENVIRONMENT
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  try {
    // A synchronous scope: React has flushed the work before it returns.
    void reactAct(callback)
  } finally {
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous
  }
}

/**
 * {@link act} for a callback that returns a promise: the flag stays on until
 * the promise settles and React has flushed.
 */
export async function actAsync<T>(callback: () => T | Promise<T>): Promise<T> {
  const previous = globalThis.IS_REACT_ACT_ENVIRONMENT
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  try {
    return await reactAct(async () => await callback())
  } finally {
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous
  }
}
