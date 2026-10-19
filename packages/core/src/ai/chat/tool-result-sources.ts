import { isNotNullish } from '@ocavue/utils'
import { z } from 'zod'

/**
 * The parser that names what a stored note-tool result read from the graph
 * (fork: chat history privacy). It knows the tool names of
 * `./note-tools-service` and every output shape those tools have persisted;
 * adding a tool means naming its sources here too. A module of its own so
 * both the tools and the history gate (`./chat-privacy-service`) can read it.
 */

/**
 * Attachment-text identity retained with a persisted search snippet.
 */
export interface SearchSnapshot {
  path: string
  assetTextHash?: string | undefined
}

/**
 * The sources and search snapshot identities persisted by a tool result.
 */
export interface ToolResultSources {
  /**
   * Notes behind search hits, listing rows, and note reads.
   */
  notes: string[]
  /**
   * Attachments whose descriptions read_assets returned.
   */
  assets: string[]
  /**
   * Search snippets require the original attachment-text identity on cloud resend.
   */
  searchSnapshots?: readonly SearchSnapshot[]
}

const sourceSchema = z.object({ path: z.string() })

/**
 * A read_notes entry, or a whole legacy read_note output.
 */
const noteReadSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), note: sourceSchema }),
  z.object({ ok: z.literal(false) }),
])

const assetReadSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), asset: sourceSchema }),
  z.object({ ok: z.literal(false) }),
])

function noteSources(entries: readonly { path: string }[]): ToolResultSources {
  return { notes: entries.map((entry) => entry.path), assets: [] }
}

const searchNotesSources = z
  .object({
    hits: z.array(
      sourceSchema.extend({
        assetTextHash: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
      }),
    ),
  })
  .transform(({ hits }) => ({ ...noteSources(hits), searchSnapshots: hits }))

const readNotesSources = z
  .object({ notes: z.array(noteReadSchema) })
  .transform(({ notes }) => noteSources(notes.flatMap((entry) => (entry.ok ? [entry.note] : []))))

const readNoteSources = noteReadSchema.transform((entry) => {
  return noteSources(entry.ok ? [entry.note] : [])
})

const readAssetsSources = z
  .object({ assets: z.array(assetReadSchema) })
  .transform(({ assets }) => ({
    notes: [],
    assets: assets.map((entry) => (entry.ok ? entry.asset.path : null)).filter(isNotNullish),
  }))

const listRecentNotesSources = z
  .union([
    z.object({ ok: z.literal(false) }),
    z.object({ ok: z.literal(true).optional(), notes: z.array(sourceSchema) }),
  ])
  .transform((output) => noteSources('notes' in output ? output.notes : []))

const listDailyNotesSources = z
  .object({ days: z.array(sourceSchema) })
  .transform(({ days }) => noteSources(days))

/**
 * Every output shape the note tools have ever persisted, reduced to its
 * sources. `read_note` is the single-note read that `read_notes` replaced,
 * and the first `list_recent_notes` returned its listing without `ok`.
 */
function storedResultSchema(toolName: string): z.ZodType<ToolResultSources> | null {
  switch (toolName) {
    case 'search_notes':
      return searchNotesSources
    case 'read_notes':
      return readNotesSources
    case 'read_note':
      return readNoteSources
    case 'read_assets':
      return readAssetsSources
    case 'list_recent_notes':
      return listRecentNotesSources
    case 'list_daily_notes':
      return listDailyNotesSources
    default:
      return null
  }
}

/**
 * The note and asset paths a stored tool result (its JSON output, as
 * persisted in a turn's model messages) carries content from, so a resend
 * can re-check them (`./chat-privacy-service`). Only entries holding
 * something read from the graph count: search hits, listing rows, and
 * successful reads. A refused or missing read echoes the model's own path
 * with a fixed message.
 *
 * Returns `null` for a tool this module does not know or an output that does
 * not parse, so the caller can fail closed.
 */
export function toolResultSources(toolName: string, output: unknown): ToolResultSources | null {
  const parsed = storedResultSchema(toolName)?.safeParse(output)
  return parsed?.success === true ? parsed.data : null
}
