import { createTestGraphSessionService } from '../../testing/graph-session.ts'
import { sha256Hex } from '@reflect/utils'
import { describe, expect, it, vi } from 'vitest'
import { AppError } from '../../errors.ts'
import type { ToolExecutionOptions } from '@reflect/modules/ai'
import type { RetrievalHit, RetrieveOptions } from '../../embeddings/retrieve.ts'
import type { DailyNoteRow, DailyNotesRange } from '../../daily/daily-note-service.ts'
import { createLocalOnlyFolders, isLocalOnlyPath } from '../../graph/local-only.ts'
import type { DeviceNoteRead, ShareableNoteRead } from '../../graph/note-file-service.ts'
import {
  createNoteListService,
  type RecentNoteRow,
  type RecentNotesOptions,
} from '../../indexing/note-list-service.ts'
import {
  AMBIGUOUS_ASSET_ERROR,
  ASSET_UNAVAILABLE_ERROR,
  MAX_ASSET_DESCRIPTION_CHARS,
  NO_ASSET_DESCRIPTION_ERROR,
  NOT_AN_ASSET_ERROR,
  type ReadAssetResult,
  type ReadAssetsOutput,
} from './read-assets.ts'
import {
  MAX_NOTE_CONTENT_CHARS,
  NOT_A_NOTE_REFUSAL,
  PRIVATE_NOTE_REFUSAL,
  type ReadNoteResult,
  type ReadNotesOutput,
} from './read-notes.ts'
import { createAssetPrivacyService } from '../../assets/asset-privacy-service.ts'
import { cloudTarget, modelTarget, type VerifiedModelTarget } from '../../privacy/on-device.ts'
import { createPrivacyService, PrivateNoteError } from '../../privacy/privacy-service.ts'
import {
  createTestAssetStoreService,
  createTestDatabaseService,
  createTestNoteFileService,
  createTestOnDeviceModelService,
  createTestRetrievalService,
  createTestXArchiveService,
} from '../../testing/index.ts'
import { createChatPrivacyService, type ChatPrivacyService } from './chat-privacy-service.ts'
import {
  createNoteToolsService,
  INVALID_TAG_ERROR,
  MAX_DAILY_NOTE_DAYS,
  type ListDailyNotesOutput,
  type ListRecentNotesOutput,
  type NoteTools,
  type SearchNotesOutput,
} from './note-tools-service.ts'

/**
 * The effects one test scripts; the rest answer as an empty graph does.
 */
interface ToolEffects {
  retrieveFn?: (query: string, options?: RetrieveOptions) => Promise<RetrievalHit[]>
  /**
   * The graph's note and sidecar sources. Rust's reads answer from them:
   * the shareable read refuses a path in a local-only folder, and the
   * on-device read reports one.
   */
  readNoteFn?: (path: string) => Promise<string>
  /**
   * Replaces Rust's shareable read, for a verdict the path's spelling hides.
   */
  readShareableFn?: (path: string) => Promise<ShareableNoteRead>
  /**
   * Replaces Rust's on-device read, for a verdict the path's spelling hides.
   */
  readDeviceNoteFn?: (path: string) => Promise<DeviceNoteRead>
  listRecentNotesFn?: (options: RecentNotesOptions) => Promise<RecentNoteRow[]>
  listDailyNotesFn?: (range: DailyNotesRange) => Promise<DailyNoteRow[]>
  assetReferencingNotePathsFn?: (assetPath: string, owners?: readonly string[]) => Promise<string[]>
  hasRestrictedSearchSourcesFn?: ChatPrivacyService['hasRestrictedSearchSources']
  xArchiveOwners?: Readonly<Record<string, readonly string[]>>
  /**
   * The attachments a bare filename resolves against on device.
   */
  attachments?: readonly string[]
  /**
   * Device-only OCR cache entries, by the SHA-256 of their asset path.
   */
  ocrCache?: Readonly<Record<string, string>>
  localOnlyFolders?: readonly string[]
  /**
   * The verified model the tools serve; a cloud model by default.
   */
  target?: VerifiedModelTarget
  semanticSearchEnabled?: boolean
}

const CLOUD = cloudTarget({ id: 'openai', provider: 'openai', model: 'gpt-5.5', keyHint: 'wxyz1' })

/**
 * A model on this Mac, verified as a passing server check mints it.
 */
async function onDeviceTarget(): Promise<VerifiedModelTarget> {
  const baseUrl = 'http://localhost:1234/v1'
  return await createTestOnDeviceModelService().verify(
    modelTarget({
      id: 'local',
      provider: 'openai-compatible',
      model: 'local',
      baseUrl,
      keyHint: '',
      onDevice: { baseUrl, model: 'local', server: 'openai-compatible' },
    }),
    '',
  )
}

/**
 * The tool set of a `NoteToolsService` over `effects`, with the real privacy gates.
 */
function buildNoteTools(effects: ToolEffects = {}): NoteTools {
  const localOnlyFolders = [...(effects.localOnlyFolders ?? [])]
  const localOnly = createLocalOnlyFolders(localOnlyFolders)
  const readSource = async (path: string): Promise<string> => {
    if (effects.readNoteFn === undefined) {
      throw new AppError('notFound', `${path} not found`)
    }
    return await effects.readNoteFn(path)
  }
  const noteFile = createTestNoteFileService()
  vi.spyOn(noteFile, 'readShareable').mockImplementation(
    effects.readShareableFn ??
      (async (path) =>
        isLocalOnlyPath(localOnly, path)
          ? { kind: 'localOnly' }
          : { kind: 'content', content: await readSource(path) }),
  )
  vi.spyOn(noteFile, 'readForDevice').mockImplementation(
    effects.readDeviceNoteFn ??
      (async (path) => ({
        content: await readSource(path),
        localOnly: isLocalOnlyPath(localOnly, path),
      })),
  )
  vi.spyOn(noteFile, 'listAttachments').mockImplementation(() =>
    Promise.resolve((effects.attachments ?? []).map((path) => ({ path, size: 1, modifiedMs: 1 }))),
  )
  const retrieval = createTestRetrievalService()
  vi.spyOn(retrieval, 'retrieve').mockImplementation(
    effects.retrieveFn ?? (() => Promise.resolve([])),
  )
  const database = createTestDatabaseService()
  const noteList = createNoteListService({ database })
  vi.spyOn(noteList, 'listRecentNotes').mockImplementation(
    effects.listRecentNotesFn ?? (() => Promise.resolve([])),
  )
  const assetReferences = {
    notePaths: effects.assetReferencingNotePathsFn ?? (() => Promise.resolve([])),
  }
  const xArchive = createTestXArchiveService(
    effects.xArchiveOwners === undefined ? {} : { owners: effects.xArchiveOwners },
  )
  const graphSession = createTestGraphSessionService({
    graph: { generation: 1, localOnlyFolders },
  })
  const assetStore = createTestAssetStoreService({ ocrCache: effects.ocrCache ?? {} })
  const assetPrivacy = createAssetPrivacyService({
    noteFile,
    xArchive,
    assetReferences,
    graphSession,
  })
  const chatPrivacy = createChatPrivacyService({
    database,
    noteFile,
    assetStore,
    assetReferences,
    assetPrivacy,
  })
  if (effects.hasRestrictedSearchSourcesFn !== undefined) {
    vi.spyOn(chatPrivacy, 'hasRestrictedSearchSources').mockImplementation(
      effects.hasRestrictedSearchSourcesFn,
    )
  }
  return createNoteToolsService({
    retrieval,
    noteFile,
    assetStore,
    noteList,
    dailyNotes: { listDailyNotes: effects.listDailyNotesFn ?? (() => []) },
    assetReferences,
    assetPrivacy,
    xArchive,
    privacy: createPrivacyService({ noteFile, graphSession }),
    chatPrivacy,
  }).build({
    semanticSearchEnabled: effects.semanticSearchEnabled ?? true,
    generation: 1,
    localOnly,
    target: effects.target ?? CLOUD,
  })
}

const CALL: ToolExecutionOptions<Record<string, unknown>> = {
  toolCallId: 'call-1',
  messages: [],
  context: {},
}

// Sentinels that cannot collide with prompt copy or fixture prose, so the
// not-in-payload assertions below can never pass vacuously.
const PRIVATE_TITLE = 'sentinel-title-01jxq3'
const PRIVATE_PATH = 'notes/sentinel-path-01jxq3.md'
const PRIVATE_BODY = 'sentinel-body-01jxq3'

/**
 * The attachment-text hash of a snapshot holding no attachment text (the empty text's SHA-256).
 */
const NO_ASSET_TEXT_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

/**
 * A folded spelling of `secure`: the long s passes the ASCII name check, and
 * Rust's verdict on the entry it resolves to is what keeps it local.
 */
const FOLDED_SECURE = '\u{17F}ecure'

/** A public retrieval hit, overridable per test. */
function hit(overrides: Partial<RetrievalHit>): RetrievalHit {
  return {
    path: 'notes/public.md',
    title: 'Public note',
    score: 1,
    snippet: 'a public snippet',
    heading: null,
    isPrivate: false,
    assetTextHash: NO_ASSET_TEXT_HASH,
    ...overrides,
  }
}

/** A public recents query row, overridable per test. */
function recentRow(overrides: Partial<RecentNoteRow>): RecentNoteRow {
  return {
    path: 'notes/public.md',
    title: 'Public note',
    preview: 'a public preview',
    mtime: 1_750_000_000_000,
    isPrivate: false,
    ...overrides,
  }
}

/** A public daily query row for `date`, overridable per test. */
function dailyRow(date: string, overrides: Partial<DailyNoteRow> = {}): DailyNoteRow {
  return {
    path: `daily/${date}.md`,
    title: date,
    dailyDate: date,
    preview: 'a daily preview',
    mtime: 1_750_000_000_000,
    isPrivate: false,
    ...overrides,
  }
}

/** Execute `search_notes` directly. */
async function runSearch(
  tools: NoteTools,
  input: { query: string; limit?: number },
): Promise<SearchNotesOutput> {
  return await tools.search_notes.execute(input, CALL)
}

/** Execute `read_notes` directly. */
async function runReadNotes(tools: NoteTools, paths: string[]): Promise<ReadNotesOutput> {
  return await tools.read_notes.execute({ paths }, CALL)
}

/** Read a single path via `read_notes`, returning its lone result. */
async function runRead(tools: NoteTools, path: string): Promise<ReadNoteResult> {
  const [note] = (await runReadNotes(tools, [path])).notes
  if (note === undefined) {
    throw new Error('read_notes returned no notes')
  }
  return note
}

/** Execute `read_assets` directly. */
async function runReadAssets(tools: NoteTools, paths: string[]): Promise<ReadAssetsOutput> {
  return await tools.read_assets.execute({ paths }, CALL)
}

/** Read a single asset via `read_assets`, returning its lone result. */
async function runReadAsset(tools: NoteTools, path: string): Promise<ReadAssetResult> {
  const [asset] = (await runReadAssets(tools, [path])).assets
  if (asset === undefined) {
    throw new Error('read_assets returned no assets')
  }
  return asset
}

/** Execute `list_recent_notes` directly. */
async function runRecents(
  tools: NoteTools,
  input: { limit?: number; tag?: string | null },
): Promise<ListRecentNotesOutput> {
  return await tools.list_recent_notes.execute(input, CALL)
}

/** Execute `list_daily_notes` directly. */
async function runDailies(
  tools: NoteTools,
  input: { start: string; end: string },
): Promise<ListDailyNotesOutput> {
  return await tools.list_daily_notes.execute(input, CALL)
}

describe('search_notes', () => {
  it('always retrieves with excludePrivateContent', async () => {
    const seen: Array<RetrieveOptions | undefined> = []
    const tools = buildNoteTools({
      retrieveFn: (_query, options) => {
        seen.push(options)
        return Promise.resolve([])
      },
    })
    await runSearch(tools, { query: 'atlas' })
    expect(seen).toEqual([{ limit: 8, mode: 'hybrid', excludePrivateContent: true }])
  })

  it('uses lexical retrieval when semantic search is disabled', async () => {
    const seen: Array<RetrieveOptions | undefined> = []
    const tools = buildNoteTools({
      semanticSearchEnabled: false,
      retrieveFn: (_query, options) => {
        seen.push(options)
        return Promise.resolve([])
      },
    })
    await runSearch(tools, { query: 'atlas' })
    expect(seen).toEqual([{ limit: 8, mode: 'lexical', excludePrivateContent: true }])
  })

  it('drops private hits entirely — not even the title goes out', async () => {
    const tools = buildNoteTools({
      retrieveFn: () =>
        Promise.resolve([
          hit({}),
          hit({ path: PRIVATE_PATH, title: PRIVATE_TITLE, snippet: '', isPrivate: true }),
        ]),
      readNoteFn: () => Promise.resolve('a public body\n'),
    })
    const output = await runSearch(tools, { query: 'diary' })
    const payload = JSON.stringify(output)
    expect(payload).not.toContain(PRIVATE_TITLE)
    expect(payload).not.toContain(PRIVATE_PATH)
    expect(output.hits).toEqual([
      {
        path: 'notes/public.md',
        title: 'Public note',
        snippet: 'a public snippet',
        heading: null,
        assetTextHash: NO_ASSET_TEXT_HASH,
      },
    ])
  })

  it('drops a hit whose live frontmatter turned private before reindex (TOCTOU)', async () => {
    const tools = buildNoteTools({
      // The stale index still says public…
      retrieveFn: () => Promise.resolve([hit({ path: PRIVATE_PATH, title: PRIVATE_TITLE })]),
      // …but the note on disk was just marked private.
      readNoteFn: () => Promise.resolve('---\nprivate: true\n---\n# Diary\n'),
    })
    const output = await runSearch(tools, { query: 'diary' })
    expect(output.hits).toEqual([])
    expect(JSON.stringify(output)).not.toContain(PRIVATE_TITLE)
  })

  it('fails closed: an unreadable hit is dropped, not sent', async () => {
    const tools = buildNoteTools({
      retrieveFn: () => Promise.resolve([hit({ path: PRIVATE_PATH, title: PRIVATE_TITLE })]),
      readNoteFn: () => Promise.reject(new AppError('io', 'disk error')),
    })
    const output = await runSearch(tools, { query: 'diary' })
    expect(output.hits).toEqual([])
  })

  it('drops a hit whose attachment text can no longer be cleared, checking only snapshots holding some', async () => {
    const assetTextHash = 'a'.repeat(64)
    const checked: Array<[path: string, hash: string | undefined]> = []
    const tools = buildNoteTools({
      retrieveFn: () => Promise.resolve([hit({}), hit({ path: 'notes/trip.md', assetTextHash })]),
      readNoteFn: () => Promise.resolve('# Trip\n\n![[scan.png]]\n'),
      hasRestrictedSearchSourcesFn: (path, _source, options) => {
        checked.push([path, options.expectedAssetTextHash])
        return Promise.resolve(true)
      },
    })
    const output = await runSearch(tools, { query: 'trip' })
    expect(output.hits.map((entry) => entry.path)).toEqual(['notes/public.md'])
    expect(checked).toEqual([['notes/trip.md', assetTextHash]])
  })

  it('passes the requested limit through', async () => {
    const seen: Array<RetrieveOptions | undefined> = []
    const tools = buildNoteTools({
      retrieveFn: (_query, options) => {
        seen.push(options)
        return Promise.resolve([])
      },
    })
    await runSearch(tools, { query: 'atlas', limit: 3 })
    expect(seen[0]?.limit).toBe(3)
  })
})

describe('read_notes', () => {
  it('reads several notes in one call, isolating a per-note miss', async () => {
    const bodies: Record<string, string> = {
      'notes/a.md': '# A\n\nAlpha.\n',
      'notes/b.md': '# B\n\nBeta.\n',
    }
    const tools = buildNoteTools({
      readNoteFn: (path) => {
        const body = bodies[path]
        if (body === undefined) {
          return Promise.reject(new AppError('notFound', 'no such note'))
        }
        return Promise.resolve(body)
      },
    })
    const output = await runReadNotes(tools, ['notes/a.md', 'notes/gone.md', 'notes/b.md'])
    // Order is preserved and a missing note refuses on its own — the readable
    // notes around it still come back.
    expect(output.notes.map((note) => note.ok)).toEqual([true, false, true])
    expect(output.notes[1]).toMatchObject({ ok: false, path: 'notes/gone.md' })
  })

  it('returns the body without frontmatter, titled from the note', async () => {
    const tools = buildNoteTools({
      readNoteFn: () =>
        Promise.resolve('---\npinned: true\n---\n# Project Atlas\n\nLaunch plan.\n'),
    })
    const output = await runRead(tools, 'notes/atlas.md')
    if (!output.ok) {
      expect.unreachable('expected a successful read')
    }
    expect(output.note.title).toBe('Project Atlas')
    expect(output.note.content).toBe('# Project Atlas\n\nLaunch plan.\n')
    expect(output.note.truncated).toBe(false)
  })

  it('refuses a private note from its live frontmatter', async () => {
    const tools = buildNoteTools({
      readNoteFn: () => Promise.resolve(`---\nprivate: true\n---\n# Diary\n\n${PRIVATE_BODY}\n`),
    })
    const output = await runRead(tools, PRIVATE_PATH)
    if (output.ok) {
      expect.unreachable('expected a refusal')
    }
    expect(output.error).toContain('private')
    expect(JSON.stringify(output)).not.toContain(PRIVATE_BODY)
  })

  it('refuses a path that is not a note without reading it', async () => {
    const reads: string[] = []
    const tools = buildNoteTools({
      readNoteFn: (path) => {
        reads.push(path)
        return Promise.resolve(`# Leak\n\n${PRIVATE_BODY}\n`)
      },
    })
    const paths = ['.git/config', '.reflect/settings.json', 'assets/a.png.reflect.md']
    const output = await runReadNotes(tools, paths)
    expect(output.notes).toEqual(
      paths.map((path) => ({ ok: false, path, error: NOT_A_NOTE_REFUSAL })),
    )
    expect(reads).toEqual([])
  })

  it('refuses a local-only note by its path without reading it', async () => {
    const reads: string[] = []
    const tools = buildNoteTools({
      localOnlyFolders: ['secure'],
      readNoteFn: (path) => {
        reads.push(path)
        return Promise.resolve(`# Bank\n\n${PRIVATE_BODY}\n`)
      },
    })
    const output = await runRead(tools, 'finance/Secure/bank.md')
    expect(output).toEqual({
      ok: false,
      path: 'finance/Secure/bank.md',
      error: PRIVATE_NOTE_REFUSAL,
    })
    expect(reads).toEqual([])
  })

  it('refuses a note Rust resolves into a local-only folder, keeping the batch', async () => {
    const folded = `people/${FOLDED_SECURE}/visa.md`
    const requested: string[] = []
    const tools = buildNoteTools({
      localOnlyFolders: ['secure'],
      readShareableFn: (path) => {
        requested.push(path)
        return Promise.resolve(
          path === folded
            ? { kind: 'localOnly' }
            : { kind: 'content', content: '# Plan\n\nPublic.\n' },
        )
      },
    })
    const output = await runReadNotes(tools, [folded, 'people/plan.md'])
    // The folded spelling passes the name check, so Rust is asked about it.
    expect(requested).toEqual([folded, 'people/plan.md'])
    expect(output.notes.map((note) => note.ok)).toEqual([false, true])
    expect(output.notes[0]).toEqual({ ok: false, path: folded, error: PRIVATE_NOTE_REFUSAL })
  })

  it('treats a PrivateNoteError from the read as a private note', async () => {
    const tools = buildNoteTools({
      readShareableFn: (path) => Promise.reject(new PrivateNoteError(path)),
    })
    const output = await runRead(tools, 'notes/plan.md')
    expect(output).toEqual({ ok: false, path: 'notes/plan.md', error: PRIVATE_NOTE_REFUSAL })
  })

  it('reports a missing note instead of throwing', async () => {
    const tools = buildNoteTools({
      readNoteFn: () => Promise.reject(new AppError('notFound', 'no such note')),
    })
    const output = await runRead(tools, 'notes/gone.md')
    if (output.ok) {
      expect.unreachable('expected a miss')
    }
    expect(output.error).toContain('No note exists')
  })

  it('caps oversized notes and flags the cut', async () => {
    const body = 'x'.repeat(MAX_NOTE_CONTENT_CHARS + 10)
    const tools = buildNoteTools({ readNoteFn: () => Promise.resolve(body) })
    const output = await runRead(tools, 'notes/big.md')
    if (!output.ok) {
      expect.unreachable('expected a successful read')
    }
    expect(output.note.content.length).toBe(MAX_NOTE_CONTENT_CHARS)
    expect(output.note.truncated).toBe(true)
  })
})

describe('read_assets', () => {
  const ASSET = 'assets/chart.png'
  const SIDECAR = 'assets/chart.png.reflect.md'
  const DESCRIPTION_BODY = 'sentinel-description-01jxq3'
  const OCR_BODY = 'sentinel-ocr-01jxq3'
  const PUBLIC_REF = '# Board deck\n\n![chart](assets/chart.png)\n'
  const PRIVATE_REF = `---\nprivate: true\n---\n# Diary\n\n![chart](assets/chart.png)\n`

  /** Tools over an in-memory file map + a fixed referencing-notes answer. */
  function assetTools(
    files: Record<string, string>,
    refs: string[],
    effects: ToolEffects = {},
  ): NoteTools {
    return buildNoteTools({
      readNoteFn: (path) => {
        const source = files[path]
        if (source === undefined) {
          return Promise.reject(new AppError('notFound', 'no such file'))
        }
        return Promise.resolve(source)
      },
      assetReferencingNotePathsFn: () => Promise.resolve(refs),
      ...effects,
    })
  }

  /**
   * The device-only OCR cache holding `state` for `assetPath`.
   */
  async function ocrCacheOf(
    assetPath: string,
    state: { status: 'complete'; body: string } | { status: 'invalid' },
  ): Promise<Record<string, string>> {
    const entry =
      state.status === 'complete'
        ? {
            version: 1,
            status: 'complete',
            deviceOnly: true,
            assetPath,
            sourceHash: 'b'.repeat(64),
            sourceSize: 1,
            providerId: 'local',
            model: 'local-ocr',
            baseUrl: 'http://localhost:1234/v1',
            pages: 1,
            generatedAt: '2026-06-01T00:00:00.000Z',
            body: state.body,
          }
        : { version: 1, status: 'invalid', deviceOnly: true, assetPath }
    return { [await sha256Hex(assetPath)]: JSON.stringify(entry) }
  }

  it('returns the sidecar body without frontmatter for a public-referenced asset', async () => {
    const tools = assetTools(
      {
        [SIDECAR]: `---\nreflectAsset: true\nsource: ${ASSET}\n---\nA bar chart.\n\nOCR: ${DESCRIPTION_BODY}\n`,
        'notes/deck.md': PUBLIC_REF,
      },
      ['notes/deck.md'],
    )
    const output = await runReadAsset(tools, ASSET)
    if (!output.ok) {
      expect.unreachable('expected a successful read')
    }
    expect(output.asset.path).toBe(ASSET)
    expect(output.asset.description).toBe(`A bar chart.\n\nOCR: ${DESCRIPTION_BODY}`)
    expect(output.asset.truncated).toBe(false)
  })

  it('reads the sidecar and its referencing notes through the shareable read', async () => {
    // The note-path gate belongs to read_notes alone: a sidecar under assets/
    // is not a note, and read_assets reads it through Rust's shareable read.
    const requested: string[] = []
    const files: Record<string, string> = {
      [SIDECAR]: '---\nreflectAsset: true\n---\nA bar chart.\n',
      'notes/deck.md': PUBLIC_REF,
    }
    const tools = buildNoteTools({
      readShareableFn: (path) => {
        requested.push(path)
        const content = files[path]
        if (content === undefined) {
          return Promise.reject(new AppError('notFound', `${path} not found`))
        }
        return Promise.resolve({ kind: 'content', content })
      },
      assetReferencingNotePathsFn: () => Promise.resolve(['notes/deck.md']),
    })
    const output = await runReadAsset(tools, ASSET)
    expect(requested).toEqual([SIDECAR, 'notes/deck.md'])
    expect(output).toMatchObject({ ok: true, asset: { path: ASSET, description: 'A bar chart.' } })
  })

  it('refuses an asset whose sidecar Rust keeps local-only', async () => {
    const tools = buildNoteTools({
      readShareableFn: (path) =>
        Promise.resolve(
          path === SIDECAR ? { kind: 'localOnly' } : { kind: 'content', content: PUBLIC_REF },
        ),
      assetReferencingNotePathsFn: () => Promise.resolve(['notes/deck.md']),
    })
    const output = await runReadAsset(tools, ASSET)
    expect(output).toEqual({ ok: false, path: ASSET, error: ASSET_UNAVAILABLE_ERROR })
  })

  it('asks the X archive for the owners of an archived media file', async () => {
    const media = 'assets/x/media/1.jpg'
    const archive = 'assets/x/posts/1.json'
    const seenOwners: (readonly string[] | undefined)[] = []
    const files: Record<string, string> = {
      [`${media}.reflect.md`]: `---\nreflectAsset: true\n---\n${DESCRIPTION_BODY}\n`,
      'notes/post.md': `# Post\n\n![post](${archive})\n`,
    }
    const tools = buildNoteTools({
      readNoteFn: (path) => {
        const source = files[path]
        if (source === undefined) {
          return Promise.reject(new AppError('notFound', 'no such file'))
        }
        return Promise.resolve(source)
      },
      assetReferencingNotePathsFn: (_assetPath, owners) => {
        seenOwners.push(owners)
        return Promise.resolve(['notes/post.md'])
      },
      xArchiveOwners: { [media]: [archive] },
    })

    const output = await runReadAsset(tools, media)

    // The note embeds the archive file, not the media file: only the owners
    // from the X archive make the asset count as publicly referenced.
    expect(seenOwners).toEqual([[archive]])
    expect(output.ok).toBe(true)
  })

  it('canonicalizes markdown-spelled paths to the indexed assets/… form', async () => {
    const spacedSidecar = 'assets/chart one.png.reflect.md'
    const tools = assetTools(
      {
        [SIDECAR]: `---\nreflectAsset: true\n---\n${DESCRIPTION_BODY}\n`,
        [spacedSidecar]: `---\nreflectAsset: true\n---\n${DESCRIPTION_BODY}\n`,
        'notes/deck.md': '# Deck\n\n![a](assets/chart.png)\n\n![b](assets/chart%20one.png)\n',
      },
      ['notes/deck.md'],
    )
    for (const [spelled, canonical] of [
      ['./assets/chart.png', ASSET],
      ['assets/chart%20one.png', 'assets/chart one.png'],
    ] as const) {
      const output = await runReadAsset(tools, spelled)
      if (!output.ok) {
        expect.unreachable(`expected a successful read for ${spelled}`)
      }
      expect(output.asset.path).toBe(canonical)
      expect(output.asset.description).toBe(DESCRIPTION_BODY)
    }
  })

  it('reads several assets in one call, isolating a per-asset miss', async () => {
    const tools = assetTools(
      {
        [SIDECAR]: `---\nreflectAsset: true\n---\n${DESCRIPTION_BODY}\n`,
        'notes/deck.md': PUBLIC_REF,
      },
      ['notes/deck.md'],
    )
    const output = await runReadAssets(tools, [ASSET, 'assets/undescribed.pdf'])
    expect(output.assets.map((asset) => asset.ok)).toEqual([true, false])
    expect(output.assets[1]).toMatchObject({
      ok: false,
      path: 'assets/undescribed.pdf',
      error: NO_ASSET_DESCRIPTION_ERROR,
    })
  })

  it('refuses when any referencing note is private — live, and without the description', async () => {
    const tools = assetTools(
      {
        [SIDECAR]: `---\nreflectAsset: true\n---\n${DESCRIPTION_BODY}\n`,
        'notes/deck.md': PUBLIC_REF,
        [PRIVATE_PATH]: PRIVATE_REF,
      },
      ['notes/deck.md', PRIVATE_PATH],
    )
    const output = await runReadAsset(tools, ASSET)
    if (output.ok) {
      expect.unreachable('expected a refusal')
    }
    expect(output.error).toBe(ASSET_UNAVAILABLE_ERROR)
    expect(JSON.stringify(output)).not.toContain(DESCRIPTION_BODY)
  })

  it('refuses an asset no note references, with the same unspecific message', async () => {
    const tools = assetTools(
      { [SIDECAR]: `---\nreflectAsset: true\n---\n${DESCRIPTION_BODY}\n` },
      [],
    )
    const output = await runReadAsset(tools, ASSET)
    if (output.ok) {
      expect.unreachable('expected a refusal')
    }
    expect(output.error).toBe(ASSET_UNAVAILABLE_ERROR)
    expect(JSON.stringify(output)).not.toContain(DESCRIPTION_BODY)
  })

  it('fails closed when a referencing note cannot be read', async () => {
    const tools = buildNoteTools({
      readNoteFn: (path) => {
        if (path === SIDECAR) {
          return Promise.resolve(`---\nreflectAsset: true\n---\n${DESCRIPTION_BODY}\n`)
        }
        return Promise.reject(new AppError('io', 'disk error'))
      },
      assetReferencingNotePathsFn: () => Promise.resolve(['notes/deck.md']),
    })
    const output = await runReadAsset(tools, ASSET)
    if (output.ok) {
      expect.unreachable('expected a refusal')
    }
    expect(output.error).toBe(ASSET_UNAVAILABLE_ERROR)
  })

  it('rejects a non-asset path without touching the filesystem', async () => {
    const reads: string[] = []
    const tools = buildNoteTools({
      readNoteFn: (path) => {
        reads.push(path)
        return Promise.reject(new AppError('notFound', 'no such file'))
      },
      assetReferencingNotePathsFn: () => Promise.resolve([]),
    })
    for (const path of ['notes/secret.md', 'assets/chart.png.reflect.md']) {
      const output = await runReadAsset(tools, path)
      if (output.ok) {
        expect.unreachable('expected a refusal')
      }
      expect(output.error).toBe(NOT_AN_ASSET_ERROR)
    }
    expect(reads).toEqual([])
  })

  it('treats an empty sidecar body as no description', async () => {
    const tools = assetTools(
      { [SIDECAR]: '---\nreflectAsset: true\n---\n\n', 'notes/deck.md': PUBLIC_REF },
      ['notes/deck.md'],
    )
    const output = await runReadAsset(tools, ASSET)
    if (output.ok) {
      expect.unreachable('expected a miss')
    }
    expect(output.error).toBe(NO_ASSET_DESCRIPTION_ERROR)
  })

  it('answers unavailable, not no-description, for a blocked asset with an empty sidecar', async () => {
    const tools = assetTools(
      { [SIDECAR]: '---\nreflectAsset: true\n---\n\n', [PRIVATE_PATH]: PRIVATE_REF },
      [PRIVATE_PATH],
    )
    const output = await runReadAsset(tools, ASSET)
    if (output.ok) {
      expect.unreachable('expected a refusal')
    }
    expect(output.error).toBe(ASSET_UNAVAILABLE_ERROR)
  })

  it('caps an oversized description and flags the cut', async () => {
    const tools = assetTools(
      {
        [SIDECAR]: 'x'.repeat(MAX_ASSET_DESCRIPTION_CHARS + 10),
        'notes/deck.md': PUBLIC_REF,
      },
      ['notes/deck.md'],
    )
    const output = await runReadAsset(tools, ASSET)
    if (!output.ok) {
      expect.unreachable('expected a successful read')
    }
    expect(output.asset.description.length).toBe(MAX_ASSET_DESCRIPTION_CHARS)
    expect(output.asset.truncated).toBe(true)
  })

  it('refuses an attachment holding device-only OCR text without reading its sidecar', async () => {
    const reads: string[] = []
    const tools = buildNoteTools({
      readNoteFn: (path) => {
        reads.push(path)
        return Promise.resolve(
          path === SIDECAR ? `---\nreflectAsset: true\n---\n${DESCRIPTION_BODY}\n` : PUBLIC_REF,
        )
      },
      assetReferencingNotePathsFn: () => Promise.resolve(['notes/deck.md']),
      ocrCache: await ocrCacheOf(ASSET, { status: 'complete', body: OCR_BODY }),
    })
    const output = await runReadAsset(tools, ASSET)
    expect(output).toEqual({ ok: false, path: ASSET, error: ASSET_UNAVAILABLE_ERROR })
    expect(reads).toEqual([])
  })

  describe('bound to a verified on-device model', () => {
    it('reads device-only OCR text when no user-authored sidecar exists, marking it private', async () => {
      const tools = assetTools({ 'notes/deck.md': PUBLIC_REF }, ['notes/deck.md'], {
        target: await onDeviceTarget(),
        ocrCache: await ocrCacheOf(ASSET, { status: 'complete', body: OCR_BODY }),
      })
      const output = await runReadAsset(tools, ASSET)
      expect(output).toMatchObject({
        ok: true,
        asset: { path: ASSET, description: OCR_BODY, reflectPrivateContext: true },
      })
    })

    it('prefers a user-authored sidecar over the OCR cache', async () => {
      const tools = assetTools(
        { [SIDECAR]: 'My own caption.\n', 'notes/deck.md': PUBLIC_REF },
        ['notes/deck.md'],
        {
          target: await onDeviceTarget(),
          ocrCache: await ocrCacheOf(ASSET, { status: 'complete', body: OCR_BODY }),
        },
      )
      const output = await runReadAsset(tools, ASSET)
      expect(output).toMatchObject({ ok: true, asset: { description: 'My own caption.' } })
      expect(JSON.stringify(output)).not.toContain(OCR_BODY)
    })

    it('hides a managed sidecar whose OCR was invalidated, as the cloud tier refuses it', async () => {
      const files = {
        [SIDECAR]: `---\nreflectAsset: true\n---\n${DESCRIPTION_BODY}\n`,
        'notes/deck.md': PUBLIC_REF,
      }
      const ocrCache = await ocrCacheOf(ASSET, { status: 'invalid' })
      const onDevice = assetTools(files, ['notes/deck.md'], {
        target: await onDeviceTarget(),
        ocrCache,
      })
      expect(await runReadAsset(onDevice, ASSET)).toEqual({
        ok: false,
        path: ASSET,
        error: NO_ASSET_DESCRIPTION_ERROR,
      })
      const cloud = assetTools(files, ['notes/deck.md'], { ocrCache })
      expect(await runReadAsset(cloud, ASSET)).toEqual({
        ok: false,
        path: ASSET,
        error: ASSET_UNAVAILABLE_ERROR,
      })
    })

    it('marks a description whose sidecar Rust reports local-only', async () => {
      const tools = buildNoteTools({
        target: await onDeviceTarget(),
        readDeviceNoteFn: (path) =>
          Promise.resolve(
            path.endsWith('.reflect.md')
              ? { content: 'Private caption', localOnly: true }
              : { content: '![photo](assets/photo.png)', localOnly: false },
          ),
        assetReferencingNotePathsFn: () => Promise.resolve(['notes/public.md']),
      })
      const output = await runReadAsset(tools, 'assets/photo.png')
      expect(output).toMatchObject({
        ok: true,
        asset: { description: 'Private caption', reflectPrivateContext: true },
      })
    })

    it('resolves a bare filename against the attachments, refusing an ambiguous one', async () => {
      const files = {
        'trips/scan.png.reflect.md': 'The scanned ticket.\n',
        'trips/plan.md': '# Plan\n\n![[scan.png]]\n',
      }
      const unique = assetTools(files, ['trips/plan.md'], {
        target: await onDeviceTarget(),
        attachments: ['trips/scan.png', 'assets/chart.png'],
      })
      expect(await runReadAsset(unique, 'scan.png')).toMatchObject({
        ok: true,
        asset: { path: 'trips/scan.png', description: 'The scanned ticket.' },
      })
      const ambiguous = assetTools(files, ['trips/plan.md'], {
        target: await onDeviceTarget(),
        attachments: ['trips/scan.png', 'archive/scan.png'],
      })
      expect(await runReadAsset(ambiguous, 'scan.png')).toEqual({
        ok: false,
        path: 'scan.png',
        error: AMBIGUOUS_ASSET_ERROR,
      })
    })

    it('reads an attachment outside assets/, which the cloud tier refuses', async () => {
      const files = {
        'trips/scan.png.reflect.md': 'The scanned ticket.\n',
        'trips/plan.md': '# Plan\n\n![scan](scan.png)\n',
      }
      const onDevice = assetTools(files, ['trips/plan.md'], { target: await onDeviceTarget() })
      expect(await runReadAsset(onDevice, 'trips/scan.png')).toMatchObject({
        ok: true,
        asset: { path: 'trips/scan.png', description: 'The scanned ticket.' },
      })
      const cloud = assetTools(files, ['trips/plan.md'])
      expect(await runReadAsset(cloud, 'trips/scan.png')).toEqual({
        ok: false,
        path: 'trips/scan.png',
        error: NOT_AN_ASSET_ERROR,
      })
    })
  })
})

describe('list_recent_notes', () => {
  it('queries with the default limit and no tag', async () => {
    const seen: RecentNotesOptions[] = []
    const tools = buildNoteTools({
      listRecentNotesFn: (options) => {
        seen.push(options)
        return Promise.resolve([])
      },
    })
    await runRecents(tools, {})
    expect(seen).toEqual([{ limit: 10, tag: null }])
  })

  it('passes an explicit limit and tag through', async () => {
    const seen: RecentNotesOptions[] = []
    const tools = buildNoteTools({
      listRecentNotesFn: (options) => {
        seen.push(options)
        return Promise.resolve([])
      },
    })
    await runRecents(tools, { limit: 3, tag: 'book' })
    expect(seen).toEqual([{ limit: 3, tag: 'book' }])
  })

  it('treats an explicit null tag as no filter', async () => {
    const seen: RecentNotesOptions[] = []
    const tools = buildNoteTools({
      listRecentNotesFn: (options) => {
        seen.push(options)
        return Promise.resolve([])
      },
    })
    await runRecents(tools, { tag: null })
    expect(seen).toEqual([{ limit: 10, tag: null }])
  })

  it('refuses a non-tag filter without querying, pointing at the no-tag call', async () => {
    const seen: RecentNotesOptions[] = []
    const tools = buildNoteTools({
      listRecentNotesFn: (options) => {
        seen.push(options)
        return Promise.resolve([])
      },
    })
    for (const tag of ['*', ' ', '#book', ']INVALIDNOFILTER[']) {
      const output = await runRecents(tools, { tag })
      if (output.ok) {
        expect.unreachable('expected a refusal')
      }
      expect(output.tag).toBe(tag)
      expect(output.error).toBe(INVALID_TAG_ERROR)
    }
    expect(seen).toEqual([])
  })

  it('maps rows onto listings: preview as snippet, ISO modifiedAt, no daily date', async () => {
    const mtime = 1_750_000_000_000
    const tools = buildNoteTools({
      listRecentNotesFn: () => Promise.resolve([recentRow({ mtime })]),
      readNoteFn: () => Promise.resolve('a public body\n'),
    })
    const output = await runRecents(tools, {})
    if (!output.ok) {
      expect.unreachable('expected a listing')
    }
    expect(output.notes).toEqual([
      {
        path: 'notes/public.md',
        title: 'Public note',
        dailyDate: null,
        snippet: 'a public preview',
        modifiedAt: new Date(mtime).toISOString(),
      },
    ])
  })

  it('drops an indexed-private row entirely — not even the title goes out', async () => {
    const tools = buildNoteTools({
      listRecentNotesFn: () =>
        Promise.resolve([
          recentRow({}),
          recentRow({ path: PRIVATE_PATH, title: PRIVATE_TITLE, isPrivate: true }),
        ]),
      readNoteFn: () => Promise.resolve('a public body\n'),
    })
    const output = await runRecents(tools, {})
    const payload = JSON.stringify(output)
    expect(payload).not.toContain(PRIVATE_TITLE)
    expect(payload).not.toContain(PRIVATE_PATH)
    if (!output.ok) {
      expect.unreachable('expected a listing')
    }
    expect(output.notes).toHaveLength(1)
  })

  it('drops a row whose live frontmatter turned private before reindex (TOCTOU)', async () => {
    const tools = buildNoteTools({
      listRecentNotesFn: () =>
        Promise.resolve([recentRow({ path: PRIVATE_PATH, title: PRIVATE_TITLE })]),
      readNoteFn: () => Promise.resolve('---\nprivate: true\n---\n# Diary\n'),
    })
    const output = await runRecents(tools, {})
    if (!output.ok) {
      expect.unreachable('expected a listing')
    }
    expect(output.notes).toEqual([])
    expect(JSON.stringify(output)).not.toContain(PRIVATE_TITLE)
  })

  it('keeps a public row that embeds restricted attachments, since listings carry no attachment text', async () => {
    const checked: string[] = []
    for (const target of [CLOUD, await onDeviceTarget()]) {
      const tools = buildNoteTools({
        target,
        listRecentNotesFn: () => Promise.resolve([recentRow({})]),
        readNoteFn: () => Promise.resolve('# Trip\n![[scan.png]]\n'),
        hasRestrictedSearchSourcesFn: (path) => {
          checked.push(path)
          return Promise.resolve(true)
        },
      })
      const output = await runRecents(tools, {})
      if (!output.ok) {
        expect.unreachable('expected a listing')
      }
      expect(output.notes).toHaveLength(1)
    }
    expect(checked).toEqual([])
  })

  it('fails closed: an unreadable row is dropped, not sent', async () => {
    const tools = buildNoteTools({
      listRecentNotesFn: () => Promise.resolve([recentRow({})]),
      readNoteFn: () => Promise.reject(new AppError('io', 'disk error')),
    })
    const output = await runRecents(tools, {})
    if (!output.ok) {
      expect.unreachable('expected a listing')
    }
    expect(output.notes).toEqual([])
  })
})

describe('list_daily_notes', () => {
  it('queries the inclusive range with one row past the day cap', async () => {
    const seen: DailyNotesRange[] = []
    const tools = buildNoteTools({
      listDailyNotesFn: (range) => {
        seen.push(range)
        return Promise.resolve([])
      },
    })
    await runDailies(tools, { start: '2026-06-01', end: '2026-06-30' })
    expect(seen).toEqual([
      { start: '2026-06-01', end: '2026-06-30', limit: MAX_DAILY_NOTE_DAYS + 1 },
    ])
  })

  it('maps days with their dates and stays untruncated within the cap', async () => {
    const tools = buildNoteTools({
      listDailyNotesFn: () => Promise.resolve([dailyRow('2026-06-10'), dailyRow('2026-06-09')]),
      readNoteFn: () => Promise.resolve('a public body\n'),
    })
    const output = await runDailies(tools, { start: '2026-06-01', end: '2026-06-30' })
    expect(output.truncated).toBe(false)
    expect(output.days.map((day) => day.dailyDate)).toEqual(['2026-06-10', '2026-06-09'])
    expect(output.days[0]?.path).toBe('daily/2026-06-10.md')
  })

  it('cuts an over-cap range to the cap and flags the truncation', async () => {
    const days = Array.from({ length: MAX_DAILY_NOTE_DAYS + 1 }, (_, index) =>
      dailyRow(`2026-05-${String(index + 1).padStart(2, '0')}`),
    )
    const tools = buildNoteTools({
      listDailyNotesFn: () => Promise.resolve(days),
      readNoteFn: () => Promise.resolve('a public body\n'),
    })
    const output = await runDailies(tools, { start: '2026-05-01', end: '2026-06-30' })
    expect(output.truncated).toBe(true)
    expect(output.days).toHaveLength(MAX_DAILY_NOTE_DAYS)
  })

  it('drops a daily whose live frontmatter turned private before reindex (TOCTOU)', async () => {
    const tools = buildNoteTools({
      listDailyNotesFn: () =>
        Promise.resolve([dailyRow('2026-06-10', { path: PRIVATE_PATH, title: PRIVATE_TITLE })]),
      readNoteFn: () => Promise.resolve('---\nprivate: true\n---\n# Diary\n'),
    })
    const output = await runDailies(tools, { start: '2026-06-01', end: '2026-06-30' })
    expect(output.days).toEqual([])
    expect(JSON.stringify(output)).not.toContain(PRIVATE_TITLE)
  })
})

describe('bound to a verified on-device model', () => {
  it('retrieves private content and retains private snippets with their provenance', async () => {
    const seen: Array<RetrieveOptions | undefined> = []
    const tools = buildNoteTools({
      target: await onDeviceTarget(),
      retrieveFn: (_query, options) => {
        seen.push(options)
        return Promise.resolve([hit({ isPrivate: true, snippet: PRIVATE_BODY })])
      },
      readNoteFn: () => Promise.resolve(`---\nprivate: true\n---\n${PRIVATE_BODY}`),
    })
    const output = await runSearch(tools, { query: 'private' })
    expect(seen).toEqual([{ limit: 8, mode: 'hybrid', excludePrivateContent: false }])
    expect(output.hits).toEqual([
      {
        path: 'notes/public.md',
        title: 'Public note',
        snippet: PRIVATE_BODY,
        heading: null,
        assetTextHash: NO_ASSET_TEXT_HASH,
        reflectPrivateContext: true,
      },
    ])
  })

  it('marks a stale public search snapshot whose sidecar Rust reports local-only', async () => {
    const tools = buildNoteTools({
      target: await onDeviceTarget(),
      retrieveFn: () =>
        Promise.resolve([hit({ snippet: PRIVATE_BODY, assetTextHash: 'a'.repeat(64) })]),
      readDeviceNoteFn: (path) =>
        Promise.resolve({
          content: path.endsWith('.reflect.md') ? PRIVATE_BODY : '# Public',
          localOnly: path.endsWith('.reflect.md'),
        }),
      // The attachment check reads the sidecar through the tools' own reader.
      hasRestrictedSearchSourcesFn: async (_path, _source, { readNote }) => {
        await readNote(`people/${FOLDED_SECURE}/scan.png.reflect.md`)
        return false
      },
    })
    const [first] = (await runSearch(tools, { query: 'caption' })).hits
    expect(first).toMatchObject({ snippet: PRIVATE_BODY, reflectPrivateContext: true })
  })

  it('reads private and local-only notes, marking each with its provenance', async () => {
    const bodies: Record<string, string> = {
      'secure/bank.md': '# Bank\n\nBalance.\n',
      [PRIVATE_PATH]: `---\nprivate: true\n---\n# Diary\n\n${PRIVATE_BODY}\n`,
      'notes/plan.md': '# Plan\n\nPublic.\n',
    }
    const tools = buildNoteTools({
      target: await onDeviceTarget(),
      localOnlyFolders: ['secure'],
      readNoteFn: (path) => Promise.resolve(bodies[path] ?? ''),
    })
    const output = await runReadNotes(tools, ['secure/bank.md', PRIVATE_PATH, 'notes/plan.md'])
    expect(output.notes).toEqual([
      {
        ok: true,
        note: {
          path: 'secure/bank.md',
          title: 'Bank',
          content: '# Bank\n\nBalance.\n',
          truncated: false,
          reflectPrivateContext: true,
        },
      },
      {
        ok: true,
        note: {
          path: PRIVATE_PATH,
          title: 'Diary',
          content: `# Diary\n\n${PRIVATE_BODY}\n`,
          truncated: false,
          reflectPrivateContext: true,
        },
      },
      {
        ok: true,
        note: {
          path: 'notes/plan.md',
          title: 'Plan',
          content: '# Plan\n\nPublic.\n',
          truncated: false,
        },
      },
    ])
  })

  it('marks a note Rust reports local-only under a folded spelling', async () => {
    const folded = `people/${FOLDED_SECURE}/visa.md`
    const tools = buildNoteTools({
      target: await onDeviceTarget(),
      localOnlyFolders: ['secure'],
      readDeviceNoteFn: (path) =>
        Promise.resolve({ content: '# Visa\n', localOnly: path === folded }),
    })
    expect(await runRead(tools, folded)).toMatchObject({
      ok: true,
      note: { path: folded, reflectPrivateContext: true },
    })
  })

  it('still refuses a path that is not a note', async () => {
    const tools = buildNoteTools({
      target: await onDeviceTarget(),
      readNoteFn: () => Promise.resolve(`# Leak\n\n${PRIVATE_BODY}\n`),
    })
    expect(await runRead(tools, '.git/config')).toEqual({
      ok: false,
      path: '.git/config',
      error: NOT_A_NOTE_REFUSAL,
    })
  })

  it('lists private notes, asking the index for them and marking their provenance', async () => {
    const recents: RecentNotesOptions[] = []
    const dailies: DailyNotesRange[] = []
    const tools = buildNoteTools({
      target: await onDeviceTarget(),
      listRecentNotesFn: (options) => {
        recents.push(options)
        return Promise.resolve([
          recentRow({}),
          recentRow({ path: PRIVATE_PATH, title: PRIVATE_TITLE, isPrivate: true }),
        ])
      },
      listDailyNotesFn: (range) => {
        dailies.push(range)
        return Promise.resolve([dailyRow('2026-06-10')])
      },
      readNoteFn: (path) =>
        Promise.resolve(
          path === 'daily/2026-06-10.md' ? '---\nprivate: true\n---\n# Today\n' : 'a public body\n',
        ),
    })
    const recent = await runRecents(tools, {})
    if (!recent.ok) {
      expect.unreachable('expected a listing')
    }
    expect(recents).toEqual([{ limit: 10, tag: null, includePrivate: true }])
    expect(recent.notes[0]).not.toHaveProperty('reflectPrivateContext')
    expect(recent.notes[1]).toMatchObject({ title: PRIVATE_TITLE, reflectPrivateContext: true })

    // The live frontmatter marks a daily the index still lists as public.
    const daily = await runDailies(tools, { start: '2026-06-01', end: '2026-06-30' })
    expect(dailies).toEqual([
      {
        start: '2026-06-01',
        end: '2026-06-30',
        limit: MAX_DAILY_NOTE_DAYS + 1,
        includePrivate: true,
      },
    ])
    expect(daily.days).toEqual([expect.objectContaining({ reflectPrivateContext: true })])
  })

  it('describes the private reach of every tool to the model', async () => {
    const onDevice = buildNoteTools({ target: await onDeviceTarget() })
    const cloud = buildNoteTools()
    for (const name of [
      'search_notes',
      'list_recent_notes',
      'list_daily_notes',
      'read_notes',
    ] as const) {
      expect(onDevice[name].description).toContain('Includes private and local-only notes')
      expect(cloud[name].description).toContain('Private notes are excluded.')
    }
    expect(onDevice.read_assets.description).toContain('Includes private attachments')
    expect(cloud.read_assets.description).toContain('Attachments of private notes cannot be read.')
  })
})
