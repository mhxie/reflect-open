import { sha256Hex } from '@reflect/utils'
import { describe, expect, it } from 'vitest'
import { createLocalOnlyFolders, NO_LOCAL_ONLY_FOLDERS } from '../graph/local-only.ts'
import {
  createNodeTestDatabaseService,
  createTestEmbeddingIndexService,
  createTestEmbeddingRuntimeService,
  createTestIndexLifecycleService,
  createTestLoggerService,
  createTestNoteFileService,
  seedNotes,
  type TestDatabaseService,
} from '../testing/index.ts'
import { passageText } from './embedding-index-service.ts'

const NOTE_PATH = 'notes/a.md'
const NONE = NO_LOCAL_ONLY_FOLDERS

async function seedStoredRows(
  database: TestDatabaseService,
  rows: ReadonlyArray<{ content_hash: string; model_id: string }>,
): Promise<void> {
  for (const row of rows) {
    await database.runQuery(
      `INSERT INTO embedding_chunks
         (note_path, heading, pos_from, pos_to, text, content_hash, model_id)
       VALUES (?, NULL, 0, 0, '', ?, ?)`,
      [NOTE_PATH, row.content_hash, row.model_id],
    )
  }
}

/**
 * An embedding index over fakes: a note on "disk" at `path` (default
 * {@link NOTE_PATH}), stored hash+model rows for the diff, and capture of
 * the embedded texts and the chunk writes. `descriptions` are the
 * `<asset>.reflect.md` sidecars; any other sidecar read is a `notFound`.
 */
async function setup(options: {
  content: string
  storedRows: Array<{ content_hash: string; model_id: string }>
  path?: string
  descriptions?: Record<string, string>
  /**
   * Report the note itself as iCloud-evicted (bytes not local).
   */
  evicted?: boolean
  /**
   * Sidecar paths (`<asset>.reflect.md`) to report as iCloud-evicted.
   */
  evictedSidecars?: string[]
}) {
  const path = options.path ?? NOTE_PATH
  const evictedSidecars = options.evictedSidecars ?? []
  const database = createNodeTestDatabaseService()
  await seedStoredRows(database, options.storedRows)
  const runtime = createTestEmbeddingRuntimeService({ vectors: () => [0.5, 0.5] })
  const index = createTestEmbeddingIndexService({
    database,
    embeddingRuntime: runtime,
    noteFile: createTestNoteFileService({
      files: {
        [path]: options.content,
        ...options.descriptions,
        ...Object.fromEntries(evictedSidecars.map((sidecar) => [sidecar, ''])),
      },
      evicted: [...(options.evicted === true ? [path] : []), ...evictedSidecars],
    }),
  })
  return {
    index,
    embedded: () => runtime.embedCalls(),
    requests: () => runtime.embedRequests(),
    applied: () => index.applied(),
    removed: () => index.removed(),
  }
}

const MODEL = 'all-MiniLM-L6-v2'

describe('embedNote', () => {
  it('pins a private-sidecar snapshot to its source hashes before an asynchronous write', async () => {
    const content = '# Public\n![scan](assets/a.png)\n'
    const { index, applied } = await setup({
      content,
      storedRows: [],
      descriptions: { 'assets/a.png.reflect.md': '---\nprivate: true\n---\nPrivate caption' },
    })
    await index.embedNote({
      path: 'notes/a.md',
      generation: 1,
      fileGeneration: 1,
      modelId: MODEL,
      localOnly: NONE,
    })
    expect(applied()[0]?.chunks.every((chunk) => chunk.isPrivate)).toBe(true)
    expect(applied()[0]?.chunks[0]).toMatchObject({
      sourceHash: await sha256Hex(content),
      assetTextHash: await sha256Hex('Private caption'),
    })
  })

  it('marks the chunks of a note inside a local-only folder private', async () => {
    const path = 'finance/secure/plan.md'
    const { index, applied } = await setup({
      path,
      content: '# Plan\n\nBudget text.\n',
      storedRows: [],
    })
    await index.embedNote({
      path,
      generation: 1,
      fileGeneration: 1,
      modelId: MODEL,
      localOnly: createLocalOnlyFolders(['secure']),
    })
    expect(applied()[0]?.chunks.map((chunk) => chunk.isPrivate)).toEqual([true])
  })

  it('leaves a public note public, hashing its exact snapshot', async () => {
    const content = '# One\n\nAlpha text.\n'
    const { index, applied } = await setup({ content, storedRows: [] })
    await index.embedNote({
      path: 'notes/a.md',
      generation: 1,
      fileGeneration: 1,
      modelId: MODEL,
      localOnly: NONE,
    })
    expect(applied()[0]?.chunks[0]).toMatchObject({
      isPrivate: false,
      sourceHash: await sha256Hex(content),
      assetTextHash: await sha256Hex(''),
    })
  })

  it('never embeds a template — boilerplate must not reach retrieval', async () => {
    const { index, embedded, applied, removed } = await setup({
      path: 'templates/journal.md',
      content: '# Journal\n\nMood:\n\nGratitude:\n',
      storedRows: [],
    })
    const count = await index.embedNote({
      path: 'templates/journal.md',
      generation: 1,
      fileGeneration: 1,
      modelId: MODEL,
      localOnly: NONE,
    })
    expect(count).toBe(0)
    expect(embedded()).toHaveLength(0)
    expect(applied()).toHaveLength(0)
    expect(removed()).toHaveLength(0)
  })

  it('skips an iCloud-evicted note without touching its stored vectors', async () => {
    // Reading an evicted note would force a blocking on-demand download —
    // the backfill must skip it, and must not embed_remove: the
    // pre-eviction vectors stay valid until new content materializes.
    const { index, embedded, applied, removed } = await setup({
      content: '# One\n\nAlpha text.\n',
      storedRows: [],
      evicted: true,
    })
    const count = await index.embedNote({
      path: 'notes/a.md',
      generation: 1,
      fileGeneration: 1,
      modelId: MODEL,
      localOnly: NONE,
    })
    expect(count).toBe(0)
    expect(embedded()).toHaveLength(0)
    expect(applied()).toHaveLength(0)
    expect(removed()).toHaveLength(0)
  })

  it('embeds everything for a brand-new note', async () => {
    const { index, embedded, requests, applied } = await setup({
      content: '# One\n\nAlpha text.\n\n# Two\n\nBeta text.\n',
      storedRows: [],
    })
    const count = await index.embedNote({
      path: 'notes/a.md',
      generation: 1,
      fileGeneration: 1,
      modelId: MODEL,
      localOnly: NONE,
    })
    expect(count).toBe(2)
    expect(embedded()).toHaveLength(1) // one batched embed_texts call
    // Passages, and the runtime refuses if another model loaded since `modelId` was read.
    expect(requests().map(({ role, model }) => ({ role, model }))).toEqual([
      { role: 'passage', model: MODEL },
    ])
    expect(applied()[0]!.chunks.every((chunk) => chunk.vector !== null)).toBe(true)
  })

  it('embeds a long note a few chunks per call, so searches can interleave', async () => {
    const sections = Array.from({ length: 20 }, (_, index) => `# Part ${index}\n\nText ${index}.`)
    const { index, embedded, applied } = await setup({
      path: 'notes/long.md',
      content: `${sections.join('\n\n')}\n`,
      storedRows: [],
    })
    const count = await index.embedNote({
      path: 'notes/long.md',
      generation: 1,
      fileGeneration: 1,
      modelId: MODEL,
      localOnly: NONE,
    })
    expect(count).toBe(20)
    expect(embedded().map((texts) => texts.length)).toEqual([8, 8, 4])
    // One apply with every vector, in chunk order.
    expect(applied()).toHaveLength(1)
    expect(applied()[0]!.chunks.every((chunk) => chunk.vector !== null)).toBe(true)
  })

  it('the hash-skip embeds nothing when stored hashes match', async () => {
    const content = '# One\n\nAlpha text.\n'
    // First pass captures the chunk hash the second pass will find "stored".
    const first = await setup({ content, storedRows: [] })
    await first.index.embedNote({
      path: 'notes/a.md',
      generation: 1,
      fileGeneration: 1,
      modelId: MODEL,
      localOnly: NONE,
    })
    const hash = first.applied()[0]!.chunks[0]!.contentHash

    const second = await setup({
      content,
      storedRows: [{ content_hash: hash, model_id: MODEL }],
    })
    const count = await second.index.embedNote({
      path: 'notes/a.md',
      generation: 1,
      fileGeneration: 1,
      modelId: MODEL,
      localOnly: NONE,
    })
    expect(count).toBe(0)
    expect(second.embedded()).toHaveLength(0) // nothing re-embedded()
    expect(second.applied()[0]!.chunks[0]!.vector).toBeNull() // metadata-only row
  })

  it('a model change re-embeds chunks whose hashes are unchanged', async () => {
    const content = '# One\n\nAlpha text.\n'
    const first = await setup({ content, storedRows: [] })
    await first.index.embedNote({
      path: 'notes/a.md',
      generation: 1,
      fileGeneration: 1,
      modelId: MODEL,
      localOnly: NONE,
    })
    const hash = first.applied()[0]!.chunks[0]!.contentHash

    const second = await setup({
      content,
      storedRows: [{ content_hash: hash, model_id: 'old-model' }],
    })
    const count = await second.index.embedNote({
      path: 'notes/a.md',
      generation: 1,
      fileGeneration: 1,
      modelId: MODEL,
      localOnly: NONE,
    })
    expect(count).toBe(1) // same hash, different model → new vector
    expect(second.embedded()).toHaveLength(1)
  })

  it('duplicate-hash chunks only skip as many embeds as rows exist', async () => {
    // Two byte-identical sections (above the runt-merge threshold) produce
    // two chunks with one hash.
    const section = `# A\n\n${'The same sentence again. '.repeat(12)}\n`
    const dup = section + section
    const first = await setup({ content: dup, storedRows: [] })
    await first.index.embedNote({
      path: 'notes/a.md',
      generation: 1,
      fileGeneration: 1,
      modelId: MODEL,
      localOnly: NONE,
    })
    const hashes = first.applied()[0]!.chunks.map((chunk) => chunk.contentHash)
    expect(hashes[0]).toBe(hashes[1]) // genuinely duplicated chunks

    // Only ONE stored row for that hash: exactly one chunk may skip; the
    // other must re-embed (vector present), or apply_chunks errors loudly.
    const second = await setup({
      content: dup,
      storedRows: [{ content_hash: hashes[0]!, model_id: MODEL }],
    })
    const count = await second.index.embedNote({
      path: 'notes/a.md',
      generation: 1,
      fileGeneration: 1,
      modelId: MODEL,
      localOnly: NONE,
    })
    expect(count).toBe(1)
    const sent = second.applied()[0]!.chunks
    expect(sent.filter((chunk) => chunk.vector === null)).toHaveLength(1)
    expect(sent.filter((chunk) => chunk.vector !== null)).toHaveLength(1)
  })

  it('an emptied note drops its chunks via embed_remove', async () => {
    const { index, applied, removed } = await setup({ content: '\n', storedRows: [] })
    const count = await index.embedNote({
      path: 'notes/a.md',
      generation: 1,
      fileGeneration: 1,
      modelId: MODEL,
      localOnly: NONE,
    })
    expect(count).toBe(0)
    expect(applied()).toHaveLength(0)
    expect(removed()).toEqual([{ path: 'notes/a.md', generation: 1 }])
  })

  const IMAGE_NOTE = '# Trip\n\nSome notes about the day.\n\n![photo](assets/pic.png)\n'
  const PIC_DESCRIPTION =
    '---\nreflectAsset: true\nsource: assets/pic.png\n---\n\nA red bridge over a misty river at dawn.\n'

  it('embeds asset description chunks after the note’s own chunks', async () => {
    const { index, applied } = await setup({
      content: IMAGE_NOTE,
      storedRows: [],
      descriptions: { 'assets/pic.png.reflect.md': PIC_DESCRIPTION },
    })
    const count = await index.embedNote({
      path: 'notes/a.md',
      generation: 1,
      fileGeneration: 1,
      modelId: MODEL,
      localOnly: NONE,
    })
    expect(count).toBeGreaterThanOrEqual(2) // note chunk(s) + the asset chunk

    const chunks = applied()[0]!.chunks
    const assetChunk = chunks[chunks.length - 1]!
    expect(assetChunk.heading).toBe('pic.png')
    expect(assetChunk.text).toContain('red bridge over a misty river')
    expect(assetChunk.text).not.toContain('reflectAsset') // frontmatter stripped
    // Synthetic positions live past the note source, so asset chunks order last.
    expect(assetChunk.posFrom).toBeGreaterThan(IMAGE_NOTE.length)
    expect(chunks.slice(0, -1).every((chunk) => chunk.posFrom < IMAGE_NOTE.length)).toBe(true)
  })

  it('skips the whole note while a referenced sidecar is evicted — chunks survive', async () => {
    // embed_apply replaces the note's entire chunk set; applying without the
    // evicted sidecar's body would silently drop its previously embedded()
    // chunks, and sidecars are untracked so nothing would restore them.
    const { index, embedded, applied, removed } = await setup({
      content: IMAGE_NOTE,
      storedRows: [{ content_hash: 'previously-stored', model_id: MODEL }],
      evictedSidecars: ['assets/pic.png.reflect.md'],
    })
    const count = await index.embedNote({
      path: 'notes/a.md',
      generation: 1,
      fileGeneration: 1,
      modelId: MODEL,
      localOnly: NONE,
    })
    expect(count).toBe(0)
    expect(embedded()).toHaveLength(0)
    expect(applied()).toHaveLength(0)
    expect(removed()).toHaveLength(0)
  })

  it('a note without a description for its asset embeds only its own text', async () => {
    const { index, applied } = await setup({ content: IMAGE_NOTE, storedRows: [] })
    await index.embedNote({
      path: 'notes/a.md',
      generation: 1,
      fileGeneration: 1,
      modelId: MODEL,
      localOnly: NONE,
    })
    expect(applied()[0]!.chunks.every((chunk) => chunk.posFrom < IMAGE_NOTE.length)).toBe(true)
  })

  it('the hash-skip covers unchanged asset description chunks', async () => {
    const descriptions = { 'assets/pic.png.reflect.md': PIC_DESCRIPTION }
    const first = await setup({ content: IMAGE_NOTE, storedRows: [], descriptions })
    await first.index.embedNote({
      path: 'notes/a.md',
      generation: 1,
      fileGeneration: 1,
      modelId: MODEL,
      localOnly: NONE,
    })
    const storedRows = first.applied()[0]!.chunks.map((chunk) => ({
      content_hash: chunk.contentHash,
      model_id: MODEL,
    }))

    const second = await setup({ content: IMAGE_NOTE, storedRows, descriptions })
    const count = await second.index.embedNote({
      path: 'notes/a.md',
      generation: 1,
      fileGeneration: 1,
      modelId: MODEL,
      localOnly: NONE,
    })
    expect(count).toBe(0)
    expect(second.embedded()).toHaveLength(0)
  })

  it('a rewritten description re-embeds only the asset chunk', async () => {
    const first = await setup({
      content: IMAGE_NOTE,
      storedRows: [],
      descriptions: { 'assets/pic.png.reflect.md': PIC_DESCRIPTION },
    })
    await first.index.embedNote({
      path: 'notes/a.md',
      generation: 1,
      fileGeneration: 1,
      modelId: MODEL,
      localOnly: NONE,
    })
    const storedRows = first.applied()[0]!.chunks.map((chunk) => ({
      content_hash: chunk.contentHash,
      model_id: MODEL,
    }))

    const second = await setup({
      content: IMAGE_NOTE,
      storedRows,
      descriptions: {
        'assets/pic.png.reflect.md': '---\nreflectAsset: true\n---\n\nNow a snowy mountain pass.\n',
      },
    })
    const count = await second.index.embedNote({
      path: 'notes/a.md',
      generation: 1,
      fileGeneration: 1,
      modelId: MODEL,
      localOnly: NONE,
    })
    expect(count).toBe(1)
    // Embedded with its context: the note title and the asset as heading.
    expect(second.embedded()).toEqual([
      [passageText('Trip', { heading: 'pic.png', text: 'Now a snowy mountain pass.' })],
    ])
    expect(second.embedded()[0]![0]).toBe('Trip › pic.png\n\nNow a snowy mountain pass.')
  })
})

describe('passageText', () => {
  it('puts the title and heading ahead of the chunk text', () => {
    expect(passageText('Trip', { heading: 'Day one', text: 'We left early.' })).toBe(
      'Trip › Day one\n\nWe left early.',
    )
    expect(passageText('  ', { heading: null, text: 'Bare text.' })).toBe('Bare text.')
  })
})

const NOTES = [
  { path: 'notes/a.md', markdown: '# A\n\nAlpha text.\n' },
  { path: 'notes/b.md', markdown: '# B\n\nBeta text.\n' },
  { path: 'templates/journal.md', markdown: '# Journal\n\nMood:\n' },
]

/**
 * An embedding index whose chunk writes land in a database indexed with {@link NOTES}.
 */
function setupGraph(options?: { unreadable?: string[]; onEmbed?: (text: string) => void }) {
  const database = createNodeTestDatabaseService()
  seedNotes(database, NOTES)
  const unreadable = options?.unreadable ?? []
  /**
   * Paths whose chunk writes reject.
   */
  const unwritable = new Set<string>()
  const logger = createTestLoggerService()
  const runtime = createTestEmbeddingRuntimeService({
    vectors: (text) => {
      options?.onEmbed?.(text)
      if (unreadable.some((marker) => text.includes(marker))) {
        throw new Error(`cannot embed ${text.trim()}`)
      }
      return Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0))
    },
  })
  const noteFile = createTestNoteFileService({
    files: Object.fromEntries(NOTES.map((note) => [note.path, note.markdown])),
  })
  const indexLifecycle = createTestIndexLifecycleService({ database, noteFile, logger })
  const index = createTestEmbeddingIndexService({
    database,
    noteFile,
    indexLifecycle,
    logger,
    embeddingRuntime: runtime,
    storeChunks: true,
    failApply: (apply) => (unwritable.has(apply.path) ? new Error('disk full') : undefined),
  })
  const storedPaths = async (): Promise<string[]> => {
    const rows = await database.db
      .selectFrom('embeddingChunks')
      .select('notePath')
      .distinct()
      .orderBy('notePath')
      .execute()
    return rows.map((row) => row.notePath)
  }
  return { index, database, noteFile, indexLifecycle, logger, runtime, storedPaths, unwritable }
}

/**
 * Long enough for every queued item of a follow to have run.
 */
async function queueDrained(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20))
}

describe('removeNote', () => {
  it('drops the chunks and vectors of a note', async () => {
    const { index, storedPaths } = setupGraph()
    await index.embedNote({
      path: 'notes/a.md',
      generation: 1,
      fileGeneration: 1,
      modelId: MODEL,
      localOnly: NONE,
    })
    await index.embedNote({
      path: 'notes/b.md',
      generation: 1,
      fileGeneration: 1,
      modelId: MODEL,
      localOnly: NONE,
    })

    await index.removeNote('notes/a.md', 1)

    expect(index.removed()).toEqual([{ path: 'notes/a.md', generation: 1 }])
    await expect(storedPaths()).resolves.toEqual(['notes/b.md'])
  })
})

describe('backfill', () => {
  it('embeds every indexed note but the templates, in path order, with progress', async () => {
    const { index, storedPaths } = setupGraph()
    const progress: Array<[number, number]> = []

    const result = await index.backfill({
      generation: 3,
      fileGeneration: 1,
      modelId: MODEL,
      localOnly: NONE,
      onProgress: (done, total) => {
        progress.push([done, total])
      },
    })

    expect(result).toBe('completed')
    expect(index.applied().map((apply) => [apply.path, apply.generation])).toEqual([
      ['notes/a.md', 3],
      ['notes/b.md', 3],
    ])
    expect(progress).toEqual([
      [1, 2],
      [2, 2],
    ])
    await expect(storedPaths()).resolves.toEqual(['notes/a.md', 'notes/b.md'])
  })

  it('embeds nothing on a second pass (the hash-skip)', async () => {
    const { index, runtime } = setupGraph()
    await index.backfill({ generation: 3, fileGeneration: 1, modelId: MODEL, localOnly: NONE })
    const embedded = runtime.embedCalls().length

    await expect(
      index.backfill({ generation: 3, fileGeneration: 1, modelId: MODEL, localOnly: NONE }),
    ).resolves.toBe('completed')

    expect(runtime.embedCalls()).toHaveLength(embedded)
  })

  it('logs one summary line per pass', async () => {
    const { index, logger } = setupGraph()

    await index.backfill({ generation: 3, fileGeneration: 1, modelId: MODEL, localOnly: NONE })
    await index.backfill({ generation: 3, fileGeneration: 1, modelId: MODEL, localOnly: NONE })

    expect(logger.getInfos()).toEqual([
      {
        message: 'embedding backfill finished',
        cause: {
          outcome: 'completed',
          modelId: MODEL,
          generation: 3,
          notes: 2,
          done: 2,
          notesEmbedded: 2,
          chunksEmbedded: 2,
          failed: 0,
          elapsedMs: 0,
        },
      },
      {
        message: 'embedding backfill finished',
        cause: {
          outcome: 'completed',
          modelId: MODEL,
          generation: 3,
          notes: 2,
          done: 2,
          notesEmbedded: 0,
          chunksEmbedded: 0,
          failed: 0,
          elapsedMs: 0,
        },
      },
    ])
  })

  it('aborts between notes once the signal aborts', async () => {
    const { index, logger } = setupGraph()
    const controller = new AbortController()

    const result = await index.backfill({
      generation: 3,
      fileGeneration: 1,
      modelId: MODEL,
      localOnly: NONE,
      onProgress: () => {
        controller.abort()
      },
      signal: controller.signal,
    })

    expect(result).toBe('aborted')
    expect(index.applied().map((apply) => apply.path)).toEqual(['notes/a.md'])
    expect(logger.getInfos().map((entry) => entry.cause)).toMatchObject([
      { outcome: 'aborted', notes: 2, done: 1 },
    ])
  })

  it('logs a note that fails and goes on with the next', async () => {
    const { index, logger } = setupGraph({ unreadable: ['Alpha'] })

    await expect(
      index.backfill({ generation: 3, fileGeneration: 1, modelId: MODEL, localOnly: NONE }),
    ).resolves.toBe('completed')

    expect(index.applied().map((apply) => apply.path)).toEqual(['notes/b.md'])
    expect(logger.getErrors()).toHaveLength(1)
    expect(logger.getErrors()[0]!.message).toBe('embedding backfill failed for notes/a.md:')
    expect(logger.getInfos().map((entry) => entry.cause)).toMatchObject([
      { outcome: 'completed', done: 2, notesEmbedded: 1, failed: 1 },
    ])
  })

  it('resolves `failed` when the note list cannot be read', async () => {
    const { index, database, logger } = setupGraph()
    database.close()

    await expect(
      index.backfill({ generation: 3, fileGeneration: 1, modelId: MODEL, localOnly: NONE }),
    ).resolves.toBe('failed')
    expect(logger.getInfos().map((entry) => entry.cause)).toMatchObject([
      { outcome: 'failed', notes: 0, done: 0 },
    ])
  })
})

describe('follow', () => {
  it('refits the vector table to the model before the backfill', async () => {
    const { index } = setupGraph()
    const preparedBeforeBackfill: number[] = []
    const stop = index.follow({
      generation: 7,
      fileGeneration: 1,
      modelId: MODEL,
      dims: 384,
      localOnly: NONE,
      runBackfill: async (backfill) => {
        preparedBeforeBackfill.push(index.prepares().length)
        return await backfill()
      },
    })
    await queueDrained()

    expect(index.prepares()).toEqual([{ model: MODEL, dims: 384, generation: 7 }])
    expect(preparedBeforeBackfill).toEqual([1])
    expect(index.applied().map((apply) => apply.path)).toEqual(['notes/a.md', 'notes/b.md'])
    stop()
  })

  it('runs the backfill through `runBackfill`, reporting its progress', async () => {
    const { index } = setupGraph()
    const events: string[] = []
    const stop = index.follow({
      generation: 7,
      fileGeneration: 1,
      modelId: MODEL,
      dims: 384,
      localOnly: NONE,
      onProgress: (done, total) => {
        events.push(`${done}/${total}`)
      },
      runBackfill: async (backfill) => {
        events.push('begin')
        try {
          return await backfill()
        } finally {
          events.push('end')
        }
      },
    })
    await queueDrained()

    expect(events).toEqual(['begin', '1/2', '2/2', 'end'])
    stop()
  })

  it('reports no progress once stopped, not even for the note in flight', async () => {
    let stop: () => void = () => {}
    const { index } = setupGraph({ onEmbed: () => stop() })
    const events: string[] = []
    stop = index.follow({
      generation: 7,
      fileGeneration: 1,
      modelId: MODEL,
      dims: 384,
      localOnly: NONE,
      onProgress: (done, total) => {
        events.push(`${done}/${total}`)
      },
    })
    await queueDrained()

    // The first note was mid-embed when the follow stopped: it lands, unreported.
    expect(index.applied().map((apply) => apply.path)).toEqual(['notes/a.md'])
    expect(events).toEqual([])
  })

  it('neither refits nor backfills once stopped before its turn', async () => {
    const { index } = setupGraph()
    const stop = index.follow({
      generation: 7,
      fileGeneration: 1,
      modelId: MODEL,
      dims: 384,
      localOnly: NONE,
    })
    stop()
    await queueDrained()

    expect(index.prepares()).toEqual([])
    expect(index.applied()).toEqual([])
  })

  it('backfills, then embeds the notes of each applied batch', async () => {
    const { index, indexLifecycle, noteFile } = setupGraph()
    const stop = index.follow({
      generation: 7,
      fileGeneration: 1,
      modelId: MODEL,
      dims: 384,
      localOnly: NONE,
    })
    await queueDrained()
    expect(index.applied().map((apply) => apply.path)).toEqual(['notes/a.md', 'notes/b.md'])

    noteFile.set('notes/a.md', '# A\n\nRewritten text.\n')
    indexLifecycle.emitApplied([{ kind: 'upsert', path: 'notes/a.md' }], 7)
    await queueDrained()

    const last = index.applied().at(-1)!
    expect([last.path, last.generation]).toEqual(['notes/a.md', 7])
    expect(last.chunks.map((chunk) => chunk.text).join('')).toContain('Rewritten text.')
    stop()
  })

  it('drops the vectors of a removed note', async () => {
    const { index, indexLifecycle, storedPaths } = setupGraph()
    const stop = index.follow({
      generation: 7,
      fileGeneration: 1,
      modelId: MODEL,
      dims: 384,
      localOnly: NONE,
    })
    await queueDrained()

    indexLifecycle.emitApplied([{ kind: 'remove', path: 'notes/a.md' }], 7)
    await queueDrained()

    expect(index.removed()).toEqual([{ path: 'notes/a.md', generation: 7 }])
    await expect(storedPaths()).resolves.toEqual(['notes/b.md'])
    stop()
  })

  it('ignores a sync pass', async () => {
    const { index, indexLifecycle } = setupGraph()
    const stop = index.follow({
      generation: 7,
      fileGeneration: 1,
      modelId: MODEL,
      dims: 384,
      localOnly: NONE,
    })
    await queueDrained()
    const before = index.applied().length

    indexLifecycle.emitApplied(null, 7)
    await queueDrained()

    expect(index.applied()).toHaveLength(before)
    expect(index.removed()).toEqual([])
    stop()
  })

  it('ignores a delayed emit from a superseded index session', async () => {
    const { index, indexLifecycle } = setupGraph()
    const stop = index.follow({
      generation: 7,
      fileGeneration: 1,
      modelId: MODEL,
      dims: 384,
      localOnly: NONE,
    })
    await queueDrained()
    const applied = index.applied().length

    indexLifecycle.emitApplied([{ kind: 'upsert', path: 'notes/a.md' }], 6)
    indexLifecycle.emitApplied([{ kind: 'remove', path: 'notes/b.md' }], 6)
    await queueDrained()

    expect(index.applied()).toHaveLength(applied)
    expect(index.removed()).toEqual([])
    stop()
  })

  it('never embeds asset-file changes riding the same batches', async () => {
    const { index, indexLifecycle } = setupGraph()
    const stop = index.follow({
      generation: 7,
      fileGeneration: 1,
      modelId: MODEL,
      dims: 384,
      localOnly: NONE,
    })
    await queueDrained()
    const applied = index.applied().length

    indexLifecycle.emitApplied(
      [
        { kind: 'upsert', path: 'assets/photo.png' },
        { kind: 'remove', path: 'assets/old.pdf' },
      ],
      7,
    )
    await queueDrained()

    expect(index.applied()).toHaveLength(applied)
    expect(index.removed()).toEqual([])
    stop()
  })

  it('skips the work still queued when it stops, and hears no later batch', async () => {
    const { index, indexLifecycle } = setupGraph()
    const stop = index.follow({
      generation: 7,
      fileGeneration: 1,
      modelId: MODEL,
      dims: 384,
      localOnly: NONE,
    })
    // Queued behind the backfill, which has not started yet.
    indexLifecycle.emitApplied([{ kind: 'remove', path: 'notes/a.md' }], 7)
    stop()
    indexLifecycle.emitApplied([{ kind: 'remove', path: 'notes/b.md' }], 7)
    await queueDrained()

    expect(index.applied()).toEqual([])
    expect(index.removed()).toEqual([])
  })

  it('logs one failing note and goes on with the queue', async () => {
    const { index, indexLifecycle, logger, noteFile, unwritable } = setupGraph()
    const stop = index.follow({
      generation: 7,
      fileGeneration: 1,
      modelId: MODEL,
      dims: 384,
      localOnly: NONE,
    })
    await queueDrained()
    const applied = index.applied().length

    noteFile.set('notes/a.md', '# A\n\nGamma text.\n')
    noteFile.set('notes/b.md', '# B\n\nDelta text.\n')
    unwritable.add('notes/a.md')
    indexLifecycle.emitApplied(
      [
        { kind: 'upsert', path: 'notes/a.md' },
        { kind: 'upsert', path: 'notes/b.md' },
      ],
      7,
    )
    await queueDrained()

    expect(logger.getErrors().map((entry) => entry.message)).toEqual([
      'embedding sync failed for notes/a.md:',
    ])
    expect(
      index
        .applied()
        .slice(applied)
        .map((apply) => apply.path),
    ).toEqual(['notes/b.md'])
    stop()
  })
})
