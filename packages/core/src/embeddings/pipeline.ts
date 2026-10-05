import { readNoteLocal } from '../graph/commands.ts'
import { isTemplatePath } from '../graph/paths.ts'
import { isLocalOnlyPath } from '../graph/local-only.ts'
import {
  gatherAssetDescriptionBodies,
  foldAssetDescriptionBodies,
} from '../indexing/asset-description-text.ts'
import { db } from '../indexing/db.ts'
import { hashContent } from '../indexing/hash.ts'
import { parseNote } from '../markdown/index.ts'
import { chunkAssetDescriptions, chunkNote, type NoteChunk } from './chunk.ts'
import { embedApply, embedRemove, embedTexts, type EmbedChunkPayload } from './commands.ts'

/**
 * The incremental embedding pass (Plan 09): chunk a note, diff chunk hashes
 * against the stored rows, embed only what changed, and apply as one
 * generation-pinned write. TS owns this orchestration (Rust supplies
 * `embed_texts` + the table writes), mirroring the indexing pipeline.
 *
 * A note's chunk set also carries its referenced assets' description bodies
 * (Plan 20 → semantic leg), mirroring the FTS fold — so a meaning-level query
 * about an image or PDF's contents surfaces the referencing note on the
 * semantic side of hybrid retrieval, not just on keyword matches.
 */

export interface EmbedNoteOptions {
  path: string
  generation: number
  /** The model recorded per vector (from the runtime's `ready` status). */
  modelId: string
  /** Pre-loaded content (the watcher path has it); read from disk if absent. */
  content?: string
}

/**
 * Bump when {@link passageText} changes shape: every stored vector then
 * re-embeds, because the hash of what it was computed from no longer matches.
 */
export const PASSAGE_VERSION = 1

/** Passages per `embedTexts` call: the runtime's own batch size (`MODEL_BATCH_SIZE`). */
const EMBED_CALL_SIZE = 8

/**
 * The text a chunk is embedded as: the note's title and the chunk's heading
 * ahead of its own text, so a chunk deep in a note still says what the note
 * is about. The stored chunk text (the hit's snippet) stays the raw chunk.
 */
export function passageText(title: string, chunk: Pick<NoteChunk, 'heading' | 'text'>): string {
  const context = [title.trim(), chunk.heading?.trim() ?? ''].filter(Boolean).join(' › ')
  return context === '' ? chunk.text : `${context}\n\n${chunk.text}`
}

/**
 * Bring one note's embeddings up to date. Returns the number of chunks that
 * were (re)embedded — 0 means the hash-skip caught everything.
 */
export async function embedNote(options: EmbedNoteOptions): Promise<number> {
  const { path, generation, modelId } = options
  if (isTemplatePath(path)) {
    return 0 // templates are boilerplate — never embedded, never retrieved
  }
  let content = options.content
  let sourceLocalOnly = false
  if (content === undefined) {
    let read: Awaited<ReturnType<typeof readNoteLocal>>
    try {
      read = await readNoteLocal(path)
    } catch {
      return 0 // deleted between event and read; the remove path handles it
    }
    if (read.kind === 'evicted') {
      // iCloud-evicted: reading would force an on-demand download, and the
      // backfill sweeping a whole evicted graph would turn into thousands of
      // serial blocking downloads. The pre-eviction vectors stay valid (rows
      // survive eviction) until a model switch refits the table. A note that
      // re-materializes with new content re-embeds in the index-applied
      // follow-up; unchanged, it waits for the next backfill (one per open).
      return 0
    }
    content = read.content
    sourceLocalOnly = read.localOnly
  }

  const parsed = parseNote({ path, source: content })
  const gathered = await gatherAssetDescriptionBodies(
    parsed.assets.map((asset) => asset.path),
    path,
  )
  if (gathered.evicted.length > 0) {
    // A referenced sidecar is iCloud-evicted. `embedApply` replaces the
    // note's *entire* chunk set, so applying without that sidecar's body
    // would silently drop its previously embedded chunks — and sidecars are
    // untracked by the watcher, so nothing would ever restore them. Skip the
    // whole note this pass; the stored vectors stay valid until the sidecar
    // is local again.
    return 0
  }
  const chunks = [
    ...(await chunkNote(path, content, parsed)),
    ...(await chunkAssetDescriptions(gathered.bodies, content.length + 1)),
  ]
  if (chunks.length === 0) {
    await embedRemove(path, generation)
    return 0
  }

  // What each chunk is embedded as, hashed: the stored hash tracks the input
  // its vector came from, so a renamed note or heading re-embeds too.
  const passages = chunks.map((chunk) => passageText(parsed.title, chunk))
  const passageHashes = await Promise.all(
    passages.map((passage) => hashContent(`${PASSAGE_VERSION}\n${passage}`)),
  )
  // Stored hash+model pairs, **counted**: duplicate identical sections mean
  // several chunks can share one hash, and only as many may skip embedding as
  // there are stored rows to pair with (apply_chunks pairs one row per
  // skipped chunk — an unmatched skip is a loud error). A model change makes
  // every chunk "new", so a model switch re-embeds with no extra bookkeeping.
  const existing = await db
    .selectFrom('embeddingChunks')
    .where('notePath', '=', path)
    .select(['contentHash', 'modelId'])
    .execute()
  const available = new Map<string, number>()
  for (const row of existing) {
    const key = `${row.modelId} ${row.contentHash}`
    available.set(key, (available.get(key) ?? 0) + 1)
  }

  const skip = passageHashes.map((hash) => {
    const key = `${modelId} ${hash}`
    const remaining = available.get(key) ?? 0
    if (remaining > 0) {
      available.set(key, remaining - 1)
      return true
    }
    return false
  })
  const toEmbed = passages.filter((_, i) => !skip[i])
  const vectors: number[][] = []
  // One call per few chunks: the model serves one call at a time, so a search
  // typed during a long note's re-embed waits for a batch, not the whole note.
  for (let at = 0; at < toEmbed.length; at += EMBED_CALL_SIZE) {
    vectors.push(...(await embedTexts(toEmbed.slice(at, at + EMBED_CALL_SIZE), 'passage')))
  }
  let vectorAt = 0
  const sourceHash = await hashContent(content)
  const assetTextHash = await hashContent(foldAssetDescriptionBodies(gathered.bodies))

  const payload: EmbedChunkPayload[] = chunks.map((chunk, i) => ({
    heading: chunk.heading,
    posFrom: chunk.posFrom,
    posTo: chunk.posTo,
    text: chunk.text,
    contentHash: passageHashes[i]!,
    modelId,
    sourceHash,
    assetTextHash,
    isPrivate:
      sourceLocalOnly ||
      parsed.frontmatter.private ||
      isLocalOnlyPath(path) ||
      gathered.bodies.some((entry) => entry.deviceOnly === true),
    // A non-skipped chunk always has a freshly-embedded vector: `vectors` is
    // exactly as long as the non-skipped chunks, consumed in order here.
    vector: skip[i] ? null : vectors[vectorAt++]!,
  }))
  await embedApply(path, payload, generation)
  return toEmbed.length
}

/**
 * Backfill every indexed note (initial enable, repair). Serialized; the
 * hash-skip makes re-runs cheap. Reports per-note progress.
 */
export async function backfillEmbeddings(options: {
  generation: number
  modelId: string
  onProgress?: (done: number, total: number) => void
  /** Abort between notes (e.g. graph switch). */
  isStale?: () => boolean
}): Promise<'completed' | 'aborted'> {
  const { generation, modelId, onProgress, isStale } = options
  const rows = await db
    .selectFrom('notes')
    .where('kind', '!=', 'template')
    .select('path')
    .orderBy('path')
    .execute()
  let done = 0
  for (const row of rows) {
    if (isStale?.()) {
      return 'aborted'
    }
    try {
      await embedNote({ path: row.path, generation, modelId })
    } catch (cause) {
      console.error(`embedding backfill failed for ${row.path}:`, cause)
    }
    done += 1
    onProgress?.(done, rows.length)
  }
  return 'completed'
}
