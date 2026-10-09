import { z } from 'zod'
import { call } from '../ipc/invoke.ts'

/** One read of the trust report file (see the Rust `wiki_trust_report_read`). */
export interface WikiTrustReportFile {
  /** Identifies this version of the file (modification time and size). */
  readonly stamp: string
  /** The file's text; null when the stamp still equals the caller's. */
  readonly contents: string | null
}

const readSchema = z
  .object({
    stamp: z.string(),
    contents: z.string().nullable(),
  })
  .nullable()

/**
 * Read the open graph's trust report at graph-relative `path`, pinned to
 * `generation`: null when no file is there, and no contents when its stamp
 * still equals `knownStamp`.
 */
export async function readWikiTrustReportFile(
  path: string,
  knownStamp: string | null,
  generation: number,
): Promise<WikiTrustReportFile | null> {
  return await call('wiki_trust_report_read', { path, knownStamp, generation }, readSchema)
}
