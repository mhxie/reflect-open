import { z } from 'zod'
import { getBridge, type Unlisten } from '../ipc/bridge.ts'
import { call } from '../ipc/invoke.ts'

/** Typed bindings for the Rust embedding runtime + vector writes (Plan 09). */

/** Byte counts for an active model download; absent until it starts. */
export const embedProgressSchema = z.object({
  /** Bytes fetched so far. */
  downloaded: z.number().int().nonnegative(),
  /** Bytes the download will fetch in total. */
  total: z.number().int().nonnegative(),
})
export type EmbedProgress = z.infer<typeof embedProgressSchema>

export const embedStatusSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('uninitialized') }),
  z.object({
    status: z.literal('loading'),
    progress: embedProgressSchema.optional(),
  }),
  z.object({
    status: z.literal('ready'),
    model: z.string(),
    /** The width the model's vectors (and so the vector table) have. */
    dims: z.number().int().positive(),
  }),
  z.object({ status: z.literal('failed'), message: z.string() }),
])
export type EmbedStatus = z.infer<typeof embedStatusSchema>

const voidSchema = z.null()
const vectorsSchema = z.array(z.array(z.number()))

export function embedStatus(): Promise<EmbedStatus> {
  return call('embed_status', {}, embedStatusSchema)
}

/**
 * Load `model` (downloading on first use; the runtime's default when absent),
 * replacing any other loaded model. Resolves with the outcome.
 */
export function embedEnsure(model?: string): Promise<EmbedStatus> {
  return call('embed_ensure', { model: model ?? null }, embedStatusSchema)
}

/**
 * Embed texts with the loaded model. `role` picks the prefix the model was
 * trained with: a search query and a stored passage embed differently.
 * Errors unless status is `ready` and, when `model` is given, the loaded
 * model is that one: a caller that read the model id before a switch must
 * not get another model's vectors (of another width) under that id.
 */
export function embedTexts(
  texts: string[],
  role: 'query' | 'passage' = 'passage',
  model?: string,
): Promise<number[][]> {
  return call('embed_texts', { texts, role, model: model ?? null }, vectorsSchema)
}

/**
 * Fit the vector table to the loaded model before embedding into it: another
 * model's vectors are dropped and the table recreated at `dims`
 * (generation-pinned). Resolves `true` when it reset anything.
 */
export function embedPrepareIndex(
  model: string,
  dims: number,
  generation: number,
): Promise<boolean> {
  return call('embed_prepare_index', { model, dims, generation }, z.boolean())
}

/** One chunk in the `embed_apply` payload; `vector` only for new/changed. */
export interface EmbedChunkPayload {
  heading: string | null
  posFrom: number
  posTo: number
  text: string
  contentHash: string
  modelId: string
  vector: number[] | null
  /** Privacy of the source snapshot, retained even if a later note projection is public. */
  isPrivate: boolean
  /** Exact Markdown and folded attachment snapshots this chunk came from. */
  sourceHash: string
  assetTextHash: string
}

/** Replace a note's chunk set (hash-diff applied in Rust; generation-pinned). */
export async function embedApply(
  path: string,
  chunks: EmbedChunkPayload[],
  generation: number,
): Promise<void> {
  await call('embed_apply', { path, chunks, generation }, voidSchema)
}

/** Drop a deleted note's chunks + vectors (generation-pinned). */
export async function embedRemove(path: string, generation: number): Promise<void> {
  await call('embed_remove', { path, generation }, voidSchema)
}

/** Live runtime status changes (download started/finished/failed). */
export function subscribeEmbedStatus(handler: (status: EmbedStatus) => void): Promise<Unlisten> {
  return getBridge().listen('embed:status', (payload) => {
    const parsed = embedStatusSchema.safeParse(payload)
    if (parsed.success) {
      handler(parsed.data)
    } else {
      console.error('invalid embed:status payload:', parsed.error)
    }
  })
}
