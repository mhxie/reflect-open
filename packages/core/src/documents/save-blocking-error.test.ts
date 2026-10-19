import { describe, expect, it } from 'vitest'
import { ReflectError } from '../errors.ts'
import { isSaveBlockingError } from './save-blocking-error.ts'

describe('isSaveBlockingError', () => {
  it('blocks on a refused local-only path', () => {
    expect(
      isSaveBlockingError(
        new ReflectError('traversal', 'the local-only folder finance/secure does not exist'),
      ),
    ).toBe(true)
  })

  it.each([
    'Permission denied (os error 13)',
    'Operation not permitted (os error 1)',
    'Read-only file system (os error 30)',
    'secure/a.md is not available offline',
  ])('blocks on the OS refusal "%s"', (message) => {
    expect(isSaveBlockingError(new ReflectError('io', message))).toBe(true)
  })

  it('leaves a changed-on-disk refusal to the conflict prompt', () => {
    expect(
      isSaveBlockingError(new ReflectError('io', 'Note changed on disk; reload before retrying')),
    ).toBe(false)
  })

  it('does not block on errors that are not app errors', () => {
    expect(isSaveBlockingError(new Error('disk full'))).toBe(false)
    expect(isSaveBlockingError(null)).toBe(false)
  })
})
