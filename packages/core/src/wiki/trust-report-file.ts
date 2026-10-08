import { z } from 'zod'
import { call } from '../ipc/invoke.ts'

/** One read of the trust report file (see the Rust `wiki_trust_report_read`). */
export interface WikiTrustReportFile {
  /** The file's modification time (epoch ms), when the platform has one. */
  readonly modifiedMs: number | null
  /** The file's text; null when unchanged since the caller's known time. */
  readonly contents: string | null
}

const readSchema = z
  .object({
    modifiedMs: z.number().nullable(),
    contents: z.string().nullable(),
  })
  .nullable()

/**
 * Read the open graph's trust report at graph-relative `path`, pinned to
 * `generation`: null when no file is there, and no contents when its
 * modification time still equals `knownModifiedMs`.
 */
export async function readWikiTrustReportFile(
  path: string,
  knownModifiedMs: number | null,
  generation: number,
): Promise<WikiTrustReportFile | null> {
  return await call('wiki_trust_report_read', { path, knownModifiedMs, generation }, readSchema)
}
