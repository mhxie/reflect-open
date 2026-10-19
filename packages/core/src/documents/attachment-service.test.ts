import type { MaybePromise } from '@reflect/utils'
import { describe, expect, it, vi } from 'vitest'
import { AppError } from '../errors.ts'
import type { AssetStoreService } from '../graph/asset-store-service.ts'
import { createLocalOnlyFolders } from '../graph/local-only.ts'
import type { NoteFileService } from '../graph/note-file-service.ts'
import type { FileMeta } from '../graph/schemas.ts'
import {
  createTestAssetStoreService,
  createTestClockService,
  createTestFileChangeService,
  createTestGraphSessionService,
  createTestNoteFileService,
  createTestProgressPort,
  createTestPlatformService,
} from '../testing/index.ts'
import {
  LARGE_FILE_BYTES,
  createAttachmentService,
  type AttachmentInsertTarget,
} from './attachment-service.ts'

interface Listing {
  path: string
  size: number
}

/**
 * A note file service listing `listing()` once `gate` settles, counting calls.
 */
function listingNoteFile(
  listing: () => MaybePromise<readonly Listing[]>,
): NoteFileService & { listings: () => number } {
  let calls = 0
  return Object.assign(createTestNoteFileService(), {
    async listAttachments(): Promise<FileMeta[]> {
      calls += 1
      const entries = await listing()
      return entries.map((entry) => ({ ...entry, modifiedMs: 0 }))
    },
    listings: () => calls,
  })
}

/**
 * The note pasted and dropped files are saved for.
 */
const NOTE = 'notes/a.md'

/**
 * This graph's local-only folders: `finance/secure` is editable, `archive` read-only.
 */
const LOCAL_ONLY = { folders: ['secure', 'archive'], editable: ['secure'] }

function setup(options?: {
  assetStore?: AssetStoreService
  noteFile?: NoteFileService
  /**
   * Open the graph with {@link LOCAL_ONLY}'s folders.
   */
  localOnly?: boolean
}) {
  const clock = createTestClockService({ now: 1_700_000_000_000 })
  const assetStore = options?.assetStore ?? createTestAssetStoreService()
  const noteFile = options?.noteFile ?? createTestNoteFileService()
  const fileChanges = createTestFileChangeService()
  const progress = createTestProgressPort()
  const graph = createTestGraphSessionService({
    graph: {
      generation: 3,
      ...(options?.localOnly === true
        ? {
            localOnlyFolders: LOCAL_ONLY.folders,
            localOnlyEditableFolders: LOCAL_ONLY.editable,
          }
        : {}),
    },
  })
  const attachments = createAttachmentService({
    assetStore,
    noteFile,
    fileChanges,
    progress,
    clock,
    platform: createTestPlatformService(),
    graphSession: graph,
  })
  return { attachments, assetStore, noteFile, fileChanges, progress, clock, graph }
}

/**
 * An asset store that picks folders by {@link LOCAL_ONLY}, like Rust does.
 */
function localOnlyAssetStore(sources?: Readonly<Record<string, string>>) {
  return createTestAssetStoreService({
    localOnly: createLocalOnlyFolders(LOCAL_ONLY.folders, LOCAL_ONLY.editable),
    ...(sources === undefined ? {} : { sources }),
  })
}

function fileOf(name: string, type: string, size = 16): File {
  const file = new File([new Uint8Array(Math.min(size, 64))], name, { type })
  Object.defineProperty(file, 'size', { value: size })
  return file
}

function assetUrl(generation: number, path: string): string {
  return `reflect-asset://localhost/${encodeURIComponent(`${generation}/${path}`)}`
}

function failing(message: string): () => Promise<never> {
  return () => Promise.reject(new AppError('io', message))
}

describe('listFiles and pdfInfo', () => {
  it('lists the attachment files of the given session, with their sizes and times', async () => {
    const listAttachments = vi.fn((): Promise<FileMeta[]> =>
      Promise.resolve([{ path: 'assets/a.png', size: 12, modifiedMs: 5 }]),
    )
    const noteFile = Object.assign(createTestNoteFileService(), { listAttachments })
    const { attachments } = setup({ noteFile })

    await expect(attachments.listFiles(3)).resolves.toEqual([
      { path: 'assets/a.png', size: 12, modifiedMs: 5 },
    ])
    expect(listAttachments).toHaveBeenCalledWith(3)
  })

  it("reads a PDF's page sizes in the given session", async () => {
    const assetStore = createTestAssetStoreService({
      pdfs: { 'assets/paper.pdf': { pages: [{ width: 612, height: 792 }] } },
    })
    const { attachments } = setup({ assetStore })

    await expect(attachments.pdfInfo('assets/paper.pdf', 3)).resolves.toEqual({
      pages: [{ width: 612, height: 792 }],
    })
    await expect(attachments.pdfInfo('assets/missing.pdf', 3)).rejects.toMatchObject({
      kind: 'invalid',
    })
  })
})

describe('saveFile', () => {
  it('names a pasted image pasted-<now>.<ext>, leaving collisions to the store', async () => {
    const { attachments } = setup()

    await expect(attachments.saveFile(fileOf('whatever.png', 'image/png'), NOTE)).resolves.toEqual({
      ok: true,
      path: 'assets/pasted-1700000000000.png',
      destination: 'assets/pasted-1700000000000.png',
    })
    await expect(attachments.saveFile(fileOf('again.png', 'image/png'), NOTE)).resolves.toEqual({
      ok: true,
      path: 'assets/pasted-1700000000000-2.png',
      destination: 'assets/pasted-1700000000000-2.png',
    })
  })

  it('keeps an attachment under its sanitized original name', async () => {
    const assetStore = createTestAssetStoreService()
    const { attachments } = setup({ assetStore })

    await expect(
      attachments.saveFile(fileOf('Q3 Report.PDF', 'application/pdf'), NOTE),
    ).resolves.toEqual({
      ok: true,
      path: 'assets/q3-report.pdf',
      destination: 'assets/q3-report.pdf',
    })
    expect(assetStore.uploads()).toEqual([
      { kind: 'blob', path: 'assets/q3-report.pdf', generation: 3 },
    ])
  })

  it('keeps a dropped image’s own name when asked to', async () => {
    const { attachments } = setup()

    await expect(
      attachments.saveFile(fileOf('Vacation Beach.png', 'image/png'), NOTE, { keepName: true }),
    ).resolves.toEqual({
      ok: true,
      path: 'assets/vacation-beach.png',
      destination: 'assets/vacation-beach.png',
    })
  })

  it('treats an image MIME without a known extension as a named attachment', async () => {
    const { attachments } = setup()

    await expect(attachments.saveFile(fileOf('Scan 1.tiff', 'image/tiff'), NOTE)).resolves.toEqual({
      ok: true,
      path: 'assets/scan-1.tiff',
      destination: 'assets/scan-1.tiff',
    })
  })

  it('saves a large file without asking, with a status-line warning after', async () => {
    const { attachments, progress } = setup()

    await attachments.saveFile(fileOf('huge.mov', 'video/quicktime', LARGE_FILE_BYTES + 1), NOTE)

    const warning = progress.findByLabel('Large file added')
    expect(warning?.status).toBe('warning')
    expect(warning?.message).toMatch(/“huge\.mov” is 25 MB/)
    expect(warning?.message).toMatch(/100 MB/)

    await attachments.saveFile(fileOf('small.pdf', 'application/pdf'), NOTE)
    expect(progress.getAll().filter((operation) => operation.status === 'warning')).toHaveLength(1)
  })

  it('saves into an editable local-only note’s own folder, linked from the vault root', async () => {
    const assetStore = localOnlyAssetStore()
    const { attachments, progress } = setup({ assetStore, localOnly: true })

    await expect(
      attachments.saveFile(
        fileOf('Scan.pdf', 'application/pdf', LARGE_FILE_BYTES + 1),
        'finance/secure/bank.md',
      ),
    ).resolves.toEqual({
      ok: true,
      path: 'finance/secure/assets/scan.pdf',
      destination: '/finance/secure/assets/scan.pdf',
    })
    // A local-only folder's attachment never enters the Git backup: no warning.
    expect(progress.getAll()).toEqual([])
  })

  it('names the note each save is for, never one cached earlier', async () => {
    const assetStore = localOnlyAssetStore()
    const { attachments } = setup({ assetStore, localOnly: true })
    const scope = attachments.createSaveScope()

    await expect(scope.saveFile(fileOf('a.pdf', 'application/pdf'), NOTE)).resolves.toBe(
      'assets/a.pdf',
    )
    await expect(
      scope.saveFile(fileOf('a.pdf', 'application/pdf'), 'finance/secure/bank.md'),
    ).resolves.toBe('/finance/secure/assets/a.pdf')
  })

  it('reports failures keyed by how the file was named, never rejecting', async () => {
    const { attachments } = setup({
      assetStore: Object.assign(createTestAssetStoreService(), {
        uploadBlob: failing('disk full'),
      }),
    })

    await expect(attachments.saveFile(fileOf('a.png', 'image/png'), NOTE)).resolves.toEqual({
      ok: false,
      error: { kind: 'image', message: 'disk full' },
    })
    await expect(attachments.saveFile(fileOf('scan.tiff', 'image/tiff'), NOTE)).resolves.toEqual({
      ok: false,
      error: { kind: 'file', message: 'disk full' },
    })
  })
})

describe('createSaveScope', () => {
  it('holds the latest failure until the next success', async () => {
    const assetStore = createTestAssetStoreService()
    let failure: string | null = 'disk full'
    const uploadBlob = assetStore.uploadBlob.bind(assetStore)
    vi.spyOn(assetStore, 'uploadBlob').mockImplementation(
      async (name, contents, notePath, generation) => {
        if (failure !== null) {
          throw new AppError('io', failure)
        }
        return await uploadBlob(name, contents, notePath, generation)
      },
    )
    const { attachments } = setup({
      assetStore,
    })
    const scope = attachments.createSaveScope()
    let notified = 0
    scope.subscribe(() => {
      notified += 1
    })

    await expect(scope.saveFile(fileOf('a.png', 'image/png'), NOTE)).resolves.toBeNull()
    expect(scope.error()).toEqual({ kind: 'image', message: 'disk full' })

    failure = null
    await expect(scope.saveFile(fileOf('b.pdf', 'application/pdf'), NOTE)).resolves.toBe(
      'assets/b.pdf',
    )
    expect(scope.error()).toBeNull()
    expect(notified).toBe(2)
  })

  it('drops an outcome that lands after a reset', async () => {
    const upload = Promise.withResolvers<string>()
    const { attachments } = setup({
      assetStore: Object.assign(createTestAssetStoreService(), {
        uploadBlob: () => upload.promise,
      }),
    })
    const scope = attachments.createSaveScope()

    const saving = scope.saveFile(fileOf('slow.pdf', 'application/pdf'), NOTE)
    scope.reset()
    upload.reject(new AppError('io', 'late failure'))

    await expect(saving).resolves.toBeNull()
    expect(scope.error()).toBeNull()
  })

  it('keeps each scope separate', async () => {
    const { attachments } = setup({
      assetStore: Object.assign(createTestAssetStoreService(), {
        uploadBlob: failing('disk full'),
      }),
    })
    const first = attachments.createSaveScope()
    const second = attachments.createSaveScope()

    await first.saveFile(fileOf('a.pdf', 'application/pdf'), NOTE)
    second.reset()

    expect(first.error()).toEqual({ kind: 'file', message: 'disk full' })
    expect(second.error()).toBeNull()
  })
})

describe('resolveImageUrl', () => {
  it('passes remote URLs through untouched', () => {
    const { attachments, graph } = setup()

    expect(attachments.resolveImageUrl('notes/a.md', 'https://example.com/cat.png')).toBe(
      'https://example.com/cat.png',
    )
    graph.setGraph(null)
    expect(attachments.resolveImageUrl('notes/a.md', 'HTTP://example.com/cat.png')).toBe(
      'HTTP://example.com/cat.png',
    )
  })

  it('maps an assets/ path onto the generation-pinned reflect-asset URL', async () => {
    const { attachments } = setup()

    await expect(attachments.resolveImageUrl('notes/a.md', 'assets/cat.png')).resolves.toBe(
      assetUrl(3, 'assets/cat.png'),
    )
    // Once the catalog is loaded, the answer is synchronous.
    expect(attachments.resolveImageUrl('notes/a.md', 'assets/cat.png')).toBe(
      assetUrl(3, 'assets/cat.png'),
    )
  })

  it("resolves a vault image from the note's own folder, preferring the file beside it", async () => {
    const noteFile = listingNoteFile(() => [
      { path: 'Projects/attachments/plan.png', size: 1 },
      { path: 'attachments/plan.png', size: 1 },
      { path: 'attachments/garden-budget.png', size: 1 },
    ])
    const { attachments } = setup({ noteFile })
    await attachments.loadCatalog()

    expect(
      attachments.resolveImageUrl(
        'Projects/Garden redesign.md',
        '../attachments/garden-budget.png',
      ),
    ).toBe(assetUrl(3, 'attachments/garden-budget.png'))
    expect(attachments.resolveImageUrl('Projects/Plan.md', 'attachments/plan.png')).toBe(
      assetUrl(3, 'Projects/attachments/plan.png'),
    )
    expect(
      attachments.resolveAssetOpenPath(
        'Projects/Garden redesign.md',
        '../attachments/garden-budget.png',
      ),
    ).toBe('attachments/garden-budget.png')
  })

  it("opens a linked page from the note's own folder, and never renders it", async () => {
    const { attachments } = setup()
    await attachments.loadCatalog()

    expect(attachments.resolveAssetOpenPath('career/Hunt/Explainers.md', 'assets/q07.html')).toBe(
      'career/Hunt/assets/q07.html',
    )
    // A page is opened, never rendered: no in-app URL for it.
    expect(
      await attachments.resolveImageUrl('career/Hunt/Explainers.md', 'assets/q07.html'),
    ).toBeUndefined()
  })

  it('waits for the first listing', async () => {
    const listing = Promise.withResolvers<readonly Listing[]>()
    const { attachments } = setup({ noteFile: listingNoteFile(() => listing.promise) })

    const url = attachments.resolveImageUrl('Home.md', 'garden-budget.png')
    expect(url).toBeInstanceOf(Promise)
    listing.resolve([{ path: 'attachments/garden-budget.png', size: 1 }])
    await expect(url).resolves.toBe(assetUrl(3, 'attachments/garden-budget.png'))
  })

  it('falls back to the vault-root reading when the listing fails', async () => {
    const { attachments } = setup({
      noteFile: Object.assign(createTestNoteFileService(), {
        listAttachments: failing('bridge down'),
      }),
    })

    await expect(attachments.resolveImageUrl('notes/a.md', 'assets/cat.png')).resolves.toBe(
      assetUrl(3, 'assets/cat.png'),
    )
  })

  it('declines unsafe paths, notes, and missing sessions', async () => {
    const { attachments, graph } = setup()

    expect(await attachments.resolveImageUrl('notes/a.md', 'assets/../secrets.env')).toBe(undefined)
    expect(await attachments.resolveImageUrl('notes/a.md', '../../outside.png')).toBe(undefined)
    expect(await attachments.resolveImageUrl('notes/a.md', 'notes/other.md')).toBe(undefined)
    graph.setGraph(null)
    expect(attachments.resolveImageUrl('notes/a.md', 'assets/cat.png')).toBeUndefined()
  })

  it('never hands a remote image of a local-only note to the webview', () => {
    const { attachments } = setup({ localOnly: true })
    const remote = 'https://example.com/chart.png'

    expect(attachments.resolveImageUrl('finance/secure/bank.md', remote)).toBeUndefined()
    expect(attachments.resolveImageUrl('archive/2019.md', remote)).toBeUndefined()
    expect(attachments.resolveImageUrl('notes/a.md', remote)).toBe(remote)
  })
})

describe('assetUrl, pdfPageUrl and imageThumbnailUrl', () => {
  it("serve an attachment of the given graph session through the shell's asset scheme", () => {
    const { attachments } = setup()

    expect(attachments.assetUrl('assets/cat.png', 7)).toBe(assetUrl(7, 'assets/cat.png'))
    expect(attachments.pdfPageUrl('Papers/paper.pdf', 2, 960, 7)).toBe(
      `${assetUrl(7, 'Papers/paper.pdf')}?reflect-preview=pdf-page&page=2&width=960`,
    )
    expect(attachments.imageThumbnailUrl('assets/cat.png', 320, 7)).toBe(
      `${assetUrl(7, 'assets/cat.png')}?reflect-preview=thumb&width=320`,
    )
  })
})

describe('resolvePreviewImageUrl', () => {
  it('serves only local raster images, with the raster-only query', async () => {
    const { attachments } = setup()

    await expect(
      attachments.resolvePreviewImageUrl('notes/alpha.md', 'https://example.com/cat.png', 7),
    ).resolves.toBeUndefined()
    await expect(
      attachments.resolvePreviewImageUrl('notes/alpha.md', '../../outside.png', 7),
    ).resolves.toBeUndefined()
    await expect(
      attachments.resolvePreviewImageUrl('notes/alpha.md', 'assets/vector.svg', 7),
    ).resolves.toBeUndefined()
    await expect(
      attachments.resolvePreviewImageUrl('notes/alpha.md', 'assets/cat.png', 7),
    ).resolves.toBe(`${assetUrl(7, 'assets/cat.png')}?reflect-preview=raster`)
  })
})

describe('resolveWikiEmbed', () => {
  it('hands out embed sources that read back as the same file', async () => {
    const noteFile = listingNoteFile(() => [
      { path: 'Media/my photo #1.png', size: 1 },
      { path: 'Media/100%.zip', size: 1 },
    ])
    const { attachments } = setup({ noteFile })
    await attachments.loadCatalog()

    const image = attachments.resolveWikiEmbed('Media/my photo #1.png')
    const file = attachments.resolveWikiEmbed('100%.zip')
    expect(image).toEqual({ kind: 'image', src: '/Media/my%20photo%20%231.png' })
    expect(attachments.resolveAttachmentPath('Home.md', '/Media/my%20photo%20%231.png')).toBe(
      'Media/my photo #1.png',
    )
    expect(file?.kind === 'file' && attachments.resolveAttachmentPath('Home.md', file.href)).toBe(
      'Media/100%.zip',
    )
    expect(attachments.resolveWikiEmbed('Deep Work')).toEqual({ kind: 'note' })
    expect(attachments.resolveWikiEmbed('../outside.png')).toBeUndefined()
  })

  it('routes a PDF embed to the image view, which previews its pages', async () => {
    const noteFile = listingNoteFile(() => [{ path: 'Papers/paper.pdf', size: 1 }])
    const { attachments } = setup({ noteFile })
    await attachments.loadCatalog()

    expect(attachments.resolveWikiEmbed('Papers/paper.pdf')).toEqual({
      kind: 'image',
      src: '/Papers/paper.pdf',
    })
    const firstPage = `${assetUrl(3, 'Papers/paper.pdf')}?reflect-preview=pdf-page&page=1&width=480`
    expect(attachments.resolveImageUrl('Home.md', 'Papers/paper.pdf')).toBe(firstPage)
    expect(attachments.resolveImageUrl('Home.md', '/Papers/paper.pdf')).toBe(firstPage)
  })
})

describe('claimsFileLink', () => {
  it('claims links to local attachments, resolved from the note folder', () => {
    const { attachments } = setup()
    const claims = (href: string): boolean => attachments.claimsFileLink('Projects/Plan.md', href)

    expect(claims('assets/q3-report.pdf')).toBe(true)
    expect(claims('assets/sub/archive.zip')).toBe(true)
    expect(claims('assets/tool.xyz')).toBe(true)
    expect(claims('assets/readme')).toBe(true)
    expect(claims('assets/../tool.xyz')).toBe(false)
    expect(claims('assets/.hidden/tool.xyz')).toBe(false)
    expect(claims('assets/tool\0.xyz')).toBe(false)
    expect(claims('other/tool.xyz')).toBe(false)
    expect(claims('../attachments/report.pdf')).toBe(true)

    expect(claims('https://example.com/q3.pdf')).toBe(false)
    expect(claims('notes/other.md')).toBe(false)
    expect(claims('assets/../secrets.env')).toBe(false)
    expect(claims(String.raw`assets\evil.pdf`)).toBe(false)
    expect(claims('assets/')).toBe(false)
    expect(claims('../../outside.pdf')).toBe(false)
  })
})

describe('resolveFileInfo', () => {
  it('lists the vault attachments once for a burst of pills', async () => {
    const noteFile = listingNoteFile(() => [
      { path: 'assets/q3-report.pdf', size: 1234 },
      { path: 'assets/archive.zip', size: 5678 },
    ])
    const { attachments } = setup({ noteFile })

    const [report, archive] = await Promise.all([
      attachments.resolveFileInfo('notes/a.md', 'assets/q3-report.pdf'),
      attachments.resolveFileInfo('notes/a.md', 'assets/archive.zip'),
    ])

    expect(report).toEqual({ size: 1234 })
    expect(archive).toEqual({ size: 5678 })
    expect(noteFile.listings()).toBe(1)
  })

  it('sizes vault attachments outside assets/, including embed sources', async () => {
    const noteFile = listingNoteFile(() => [{ path: 'attachments/report.pdf', size: 42 }])
    const { attachments } = setup({ noteFile })

    await expect(
      attachments.resolveFileInfo('Projects/Plan.md', '../attachments/report.pdf'),
    ).resolves.toEqual({ size: 42 })
    await expect(
      attachments.resolveFileInfo('Projects/Plan.md', '/attachments/report.pdf'),
    ).resolves.toEqual({ size: 42 })
  })

  it('serves a just-saved file from the save itself', async () => {
    const noteFile = listingNoteFile(() => [])
    const { attachments, graph } = setup({ noteFile })

    await attachments.saveFile(fileOf('Q3 Report.PDF', 'application/pdf', 1234), NOTE)

    await expect(
      attachments.resolveFileInfo('notes/a.md', 'assets/q3-report.pdf'),
    ).resolves.toEqual({ size: 1234 })
    expect(noteFile.listings()).toBe(0)
    // Another graph session never sees it.
    graph.setGraph({ generation: 4 })
    await expect(
      attachments.resolveFileInfo('notes/a.md', 'assets/q3-report.pdf'),
    ).resolves.toBeUndefined()
  })

  it('serves a just-saved local-only attachment from the save, by its vault-absolute link', async () => {
    const noteFile = listingNoteFile(() => [])
    const { attachments } = setup({ noteFile, assetStore: localOnlyAssetStore(), localOnly: true })

    await expect(
      attachments.saveFile(fileOf('Scan.pdf', 'application/pdf', 4321), 'finance/secure/bank.md'),
    ).resolves.toMatchObject({ ok: true, destination: '/finance/secure/assets/scan.pdf' })

    await expect(
      attachments.resolveFileInfo('finance/secure/bank.md', '/finance/secure/assets/scan.pdf'),
    ).resolves.toEqual({ size: 4321 })
    expect(noteFile.listings()).toBe(0)
  })

  it('declines remote or unsafe hrefs, missing files, and missing sessions', async () => {
    const noteFile = listingNoteFile(() => [
      { path: 'secrets.env', size: 9 },
      { path: 'assets/other.pdf', size: 9 },
    ])
    const { attachments, graph } = setup({ noteFile })

    await expect(
      attachments.resolveFileInfo('notes/a.md', 'https://example.com/q3.pdf'),
    ).resolves.toBeUndefined()
    await expect(
      attachments.resolveFileInfo('notes/a.md', 'assets/../secrets.env'),
    ).resolves.toBeUndefined()
    await expect(
      attachments.resolveFileInfo('notes/a.md', 'assets/gone.pdf'),
    ).resolves.toBeUndefined()
    const listings = noteFile.listings()
    graph.setGraph(null)
    await expect(
      attachments.resolveFileInfo('notes/a.md', 'assets/other.pdf'),
    ).resolves.toBeUndefined()
    expect(noteFile.listings()).toBe(listings)
  })

  it('degrades to no size when the listing fails', async () => {
    const { attachments } = setup({
      noteFile: Object.assign(createTestNoteFileService(), {
        listAttachments: failing('bridge down'),
      }),
    })

    await expect(
      attachments.resolveFileInfo('notes/a.md', 'assets/q3.pdf'),
    ).resolves.toBeUndefined()
  })

  it('never serves a listing that lands after the graph session switched', async () => {
    const listings: PromiseWithResolvers<readonly Listing[]>[] = []
    const { attachments, graph } = setup({
      noteFile: listingNoteFile(() => {
        const listing = Promise.withResolvers<readonly Listing[]>()
        listings.push(listing)
        return listing.promise
      }),
    })

    const staleLookup = attachments.resolveFileInfo('notes/a.md', 'assets/q3.pdf')
    await Promise.resolve()
    graph.setGraph({ generation: 4 })
    const freshLookup = attachments.resolveFileInfo('notes/a.md', 'assets/q3.pdf')
    listings[0]?.resolve([{ path: 'assets/q3.pdf', size: 999 }])
    await staleLookup
    expect(attachments.peekCatalog()).toBeNull()

    listings[1]?.resolve([{ path: 'assets/q3.pdf', size: 111 }])
    await expect(freshLookup).resolves.toEqual({ size: 111 })
  })
})

describe('watchCatalog', () => {
  it('re-lists when an attachment changes, not when only a note does', async () => {
    let files: readonly Listing[] = []
    const noteFile = listingNoteFile(() => files)
    const { attachments, fileChanges } = setup({ noteFile })
    let changes = 0
    attachments.onCatalogChanged(() => {
      changes += 1
    })

    const stop = attachments.watchCatalog(3)
    await attachments.loadCatalog()
    expect(noteFile.listings()).toBe(1)
    expect(changes).toBe(1)

    fileChanges.emit({
      changes: [{ path: 'Home.md', kind: 'upsert', modifiedMs: 1 }],
      source: 'external',
    })
    await Promise.resolve()
    expect(noteFile.listings()).toBe(1)

    files = [{ path: 'attachments/garden-budget.png', size: 1 }]
    fileChanges.emit({
      changes: [{ path: 'attachments/garden-budget.png', kind: 'upsert', modifiedMs: 1 }],
      source: 'external',
    })
    await expect.poll(() => changes).toBe(2)
    expect(noteFile.listings()).toBe(2)
    expect(attachments.resolveImageUrl('Home.md', 'garden-budget.png')).toBe(
      assetUrl(3, 'attachments/garden-budget.png'),
    )

    stop()
    expect(fileChanges.listenerCount()).toEqual({ changes: 0, reconcile: 0, ownWrites: 0 })
  })

  it('re-lists on a folder-level reconcile request', async () => {
    const noteFile = listingNoteFile(() => [])
    const { attachments, fileChanges } = setup({ noteFile })

    attachments.watchCatalog(3)
    await attachments.loadCatalog()
    fileChanges.emitReconcile()

    await expect.poll(() => noteFile.listings()).toBe(2)
  })

  it('keeps the catalog and stays quiet when a re-listing is unchanged', async () => {
    const noteFile = listingNoteFile(() => [{ path: 'assets/a.png', size: 1 }])
    const { attachments, fileChanges } = setup({ noteFile })
    let changes = 0
    attachments.onCatalogChanged(() => {
      changes += 1
    })

    attachments.watchCatalog(3)
    const first = await attachments.loadCatalog()
    fileChanges.emitReconcile()
    await expect.poll(() => noteFile.listings()).toBe(2)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(attachments.peekCatalog()).toBe(first)
    expect(changes).toBe(1)
  })
})

function editor(): AttachmentInsertTarget & { inserted: string[]; focused: number } {
  const target = {
    inserted: [] as string[],
    focused: 0,
    insertMarkdown(markdown: string) {
      target.inserted.push(markdown)
    },
    focus() {
      target.focused += 1
    },
  }
  return target
}

describe('attachFilesToNote', () => {
  it('imports each pick and inserts one per line at the caret, embedding PDFs', async () => {
    const assetStore = createTestAssetStoreService({
      sources: { '/Users/me/Q3 Report.pdf': 'a', '/Users/me/archive.tar.gz': 'b' },
    })
    const { attachments } = setup({ assetStore })
    const target = editor()

    await attachments.attachFilesToNote({
      notePath: 'notes/plan.md',
      sources: ['/Users/me/Q3 Report.pdf', '/Users/me/archive.tar.gz'],
      findEditor: () => target,
    })

    expect(assetStore.uploads()).toEqual([
      { kind: 'import', path: 'assets/q3-report.pdf', generation: 3 },
      { kind: 'import', path: 'assets/archive-tar.gz', generation: 3 },
    ])
    expect(target.inserted).toEqual([
      '![](assets/q3-report.pdf)\n[archive.tar.gz](assets/archive-tar.gz)',
    ])
    expect(target.focused).toBe(1)
  })

  it('escapes bracketed filenames in the link label', async () => {
    const { attachments } = setup({
      assetStore: createTestAssetStoreService({ sources: { '/tmp/report [v2].docx': 'a' } }),
    })
    const target = editor()

    await attachments.attachFilesToNote({
      notePath: 'notes/plan.md',
      sources: ['/tmp/report [v2].docx'],
      findEditor: () => target,
    })

    expect(target.inserted).toEqual([String.raw`[report \[v2\].docx](assets/report-v2.docx)`])
  })

  it('does nothing without a mounted editor or a source', async () => {
    const assetStore = createTestAssetStoreService({ sources: { '/tmp/report.pdf': 'a' } })
    const { attachments } = setup({ assetStore })

    await attachments.attachFilesToNote({
      notePath: 'notes/plan.md',
      sources: ['/tmp/report.pdf'],
      findEditor: () => null,
    })

    const target = editor()
    await attachments.attachFilesToNote({
      notePath: 'notes/plan.md',
      sources: [],
      findEditor: () => target,
    })
    expect(assetStore.uploads()).toEqual([])
    expect(target.inserted).toEqual([])
  })

  it('looks the editor up again after the copies and reports a closed note', async () => {
    const assetStore = createTestAssetStoreService({ sources: { '/tmp/report.pdf': 'a' } })
    const { attachments, progress } = setup({ assetStore })
    const target = editor()
    let mounted = true

    const attaching = attachments.attachFilesToNote({
      notePath: 'notes/plan.md',
      sources: ['/tmp/report.pdf'],
      findEditor: () => (mounted ? target : null),
    })
    mounted = false
    await attaching

    expect(assetStore.uploads()).toHaveLength(1)
    expect(target.inserted).toEqual([])
    const failure = progress.findByLabel('Attaching file')
    expect(failure?.status).toBe('failed')
    expect(failure?.message).toMatch(/report\.pdf were still copied into assets\//)
  })

  it('copies into an editable local-only note’s own folder and links it from the vault root', async () => {
    const assetStore = localOnlyAssetStore({
      '/Users/me/Q3 Report.pdf': 'a',
      '/Users/me/scan.png': 'b',
    })
    const { attachments } = setup({ assetStore, localOnly: true })
    const target = editor()

    await attachments.attachFilesToNote({
      notePath: 'finance/secure/bank.md',
      sources: ['/Users/me/Q3 Report.pdf', '/Users/me/scan.png'],
      findEditor: () => target,
    })

    expect(assetStore.uploads()).toEqual([
      { kind: 'import', path: 'finance/secure/assets/q3-report.pdf', generation: 3 },
      { kind: 'import', path: 'finance/secure/assets/scan.png', generation: 3 },
    ])
    expect(target.inserted).toEqual([
      '![](/finance/secure/assets/q3-report.pdf)\n[scan.png](/finance/secure/assets/scan.png)',
    ])
  })

  it('names the local-only folder that kept the copies when the note closed meanwhile', async () => {
    const assetStore = localOnlyAssetStore({ '/tmp/report.pdf': 'a' })
    const { attachments, progress } = setup({ assetStore, localOnly: true })
    const target = editor()
    let mounted = true

    const attaching = attachments.attachFilesToNote({
      notePath: 'finance/secure/bank.md',
      sources: ['/tmp/report.pdf'],
      findEditor: () => (mounted ? target : null),
    })
    mounted = false
    await attaching

    expect(progress.findByLabel('Attaching file')?.message).toMatch(
      /still copied into finance\/secure\/assets\//,
    )
  })

  it('takes nothing into a read-only local-only note', async () => {
    const assetStore = localOnlyAssetStore({ '/tmp/report.pdf': 'a' })
    const { attachments, progress } = setup({ assetStore, localOnly: true })
    const target = editor()

    await attachments.attachFilesToNote({
      notePath: 'archive/2019/q1.md',
      sources: ['/tmp/report.pdf'],
      findEditor: () => target,
    })

    expect(assetStore.uploads()).toEqual([])
    expect(target.inserted).toEqual([])
    expect(progress.getAll()).toEqual([])
  })

  it('never inserts the copied names into a different editor mounted meanwhile', async () => {
    // Another graph's same-path pane takes the note's place during the copies.
    const assetStore = createTestAssetStoreService({
      sources: { '/tmp/private-statement.pdf': 'a' },
    })
    const { attachments, progress } = setup({ assetStore })
    const original = editor()
    const other = editor()
    let current = original

    const attaching = attachments.attachFilesToNote({
      notePath: 'finance/secure/bank.md',
      sources: ['/tmp/private-statement.pdf'],
      findEditor: () => current,
    })
    current = other
    await attaching

    expect(original.inserted).toEqual([])
    expect(other.inserted).toEqual([])
    expect(progress.findByLabel('Attaching file')?.message).toContain(
      'private-statement.pdf were still copied',
    )
  })

  it('continues past a failed copy, links every file that landed, and reports the failure', async () => {
    const assetStore = createTestAssetStoreService({
      sources: { '/tmp/good.pdf': 'a', '/tmp/also good.pdf': 'b' },
    })
    const { attachments, progress } = setup({ assetStore })
    const target = editor()

    await attachments.attachFilesToNote({
      notePath: 'notes/plan.md',
      sources: ['/tmp/bad.bin', '/tmp/good.pdf', '/tmp/also good.pdf'],
      findEditor: () => target,
    })

    expect(target.inserted).toEqual(['![](assets/good.pdf)\n![](assets/also-good.pdf)'])
    const failure = progress.findByLabel('Attaching file')
    expect(failure?.status).toBe('failed')
    expect(failure?.message).toBe('could not be copied: bad.bin (/tmp/bad.bin not found)')
  })
})

describe('openOrReveal', () => {
  it('opens without touching the reveal fallback', async () => {
    const assetStore = createTestAssetStoreService()
    const { attachments, progress } = setup({ assetStore })

    await attachments.openOrReveal('assets/q3-report.pdf')

    expect(assetStore.opened()).toEqual(['assets/q3-report.pdf'])
    expect(assetStore.revealed()).toEqual([])
    expect(progress.getAll()).toEqual([])
  })

  it('degrades a refused file type to a reveal, with a status-line note', async () => {
    const assetStore = createTestAssetStoreService()
    const { attachments, progress } = setup({
      assetStore: Object.assign(assetStore, { open: failing('not a supported attachment path') }),
    })

    await attachments.openOrReveal('assets/tool.xyz')

    expect(assetStore.revealed()).toEqual(['assets/tool.xyz'])
    const warning = progress.findByLabel('Opening attachment')
    expect(warning?.status).toBe('warning')
    expect(warning?.message).toMatch(/revealed in Finder/)
  })

  it('surfaces the open error when the reveal fails too', async () => {
    const { attachments, progress } = setup({
      assetStore: Object.assign(createTestAssetStoreService(), {
        open: failing('not a supported attachment path: assets/tool.xyz'),
        reveal: failing('asset not found: assets/tool.xyz'),
      }),
    })

    await attachments.openOrReveal('assets/tool.xyz')

    const failure = progress.findByLabel('Opening attachment')
    expect(failure?.status).toBe('failed')
    expect(failure?.message).toBe('not a supported attachment path: assets/tool.xyz')
  })
})

describe('reveal', () => {
  it('shows a note in the file manager without opening it', async () => {
    const assetStore = createTestAssetStoreService({ generation: 3 })
    const { attachments, progress } = setup({ assetStore })

    await attachments.reveal('notes/source.md', 3)

    expect(assetStore.revealed()).toEqual(['notes/source.md'])
    expect(assetStore.opened()).toEqual([])
    expect(progress.getAll()).toEqual([])
  })

  it('rejects what the shell refuses, for the caller to show', async () => {
    const assetStore = createTestAssetStoreService({ generation: 3 })
    const { attachments } = setup({ assetStore })

    await expect(attachments.reveal('notes/source.md', 2)).rejects.toThrow(/graph changed/)
    expect(assetStore.revealed()).toEqual([])
  })
})

describe('with no graph open', () => {
  it('saves, attaches, and opens nothing, and rejects a catalog load', async () => {
    const assetStore = createTestAssetStoreService({ sources: { '/tmp/report.pdf': 'a' } })
    const { attachments, graph } = setup({ assetStore })
    const scope = attachments.createSaveScope()
    graph.setGraph(null)

    await expect(attachments.saveFile(fileOf('a.pdf', 'application/pdf'), NOTE)).resolves.toBeNull()
    await expect(scope.saveFile(fileOf('a.pdf', 'application/pdf'), NOTE)).resolves.toBeNull()
    await attachments.attachFilesToNote({
      notePath: 'notes/plan.md',
      sources: ['/tmp/report.pdf'],
      findEditor: () => editor(),
    })
    await attachments.openOrReveal('assets/a.pdf')

    expect(scope.error()).toBeNull()
    expect(assetStore.uploads()).toEqual([])
    expect(attachments.peekCatalog()).toBeNull()
    await expect(attachments.loadCatalog()).rejects.toThrow('No graph is open.')
  })
})
