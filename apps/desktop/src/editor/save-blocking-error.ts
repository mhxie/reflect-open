import { isAppError } from '@reflect/core'

/**
 * The OS refusals that no retry fixes on its own: permission denied
 * (`EACCES`), an operation not permitted (`EPERM`), a read-only volume
 * (`EROFS`), as Rust's `std::io::Error` spells them; and a file whose bytes
 * are not on this Mac (the no-follow IO's dataless refusal).
 */
const BLOCKING_IO_MESSAGE = /\(os error (?:1|13|30)\)|not available offline/

/**
 * Whether a failed save inside a local-only folder is one that retrying
 * alone won't fix, so the editor should stop taking input until a save
 * lands: the edit resolver refused the path (`traversal`: the folder's link
 * dangles or was swapped, the folder is missing, or the path resolves into a
 * read-only folder), or the IO hit a {@link BLOCKING_IO_MESSAGE} refusal. A
 * "changed on disk" refusal is not one: it feeds the conflict prompt.
 */
export function isSaveBlockingError(cause: unknown): boolean {
  if (!isAppError(cause)) {
    return false
  }
  return (
    cause.kind === 'traversal' || (cause.kind === 'io' && BLOCKING_IO_MESSAGE.test(cause.message))
  )
}
