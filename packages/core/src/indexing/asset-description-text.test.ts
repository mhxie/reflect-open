import { sha256Hex } from '@reflect/utils'
import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { AppError } from '../errors.ts'
import {
  createLocalOnlyFolders,
  NO_LOCAL_ONLY_FOLDERS,
  type LocalOnlyFolders,
} from '../graph/local-only.ts'
import type { NoteFileService } from '../graph/note-file-service.ts'
import {
  createTestAssetStoreService,
  createTestNoteFileService,
  type TestNoteFileService,
} from '../testing/index.ts'
import {
  createAssetDescriptionText,
  MAX_ASSET_TEXT_CHARS,
  type AssetDescriptionGatherOptions,
  type AssetDescriptionText,
} from './asset-description-text.ts'

let noteFile: TestNoteFileService
let readNoteMock: MockInstance<NoteFileService['readLocal']>
let assetText: AssetDescriptionText

/** The gather options of a note at the graph root in a graph without local-only folders. */
const AT_ROOT: AssetDescriptionGatherOptions = {
  notePath: 'notes/a.md',
  fileGeneration: 1,
  localOnly: NO_LOCAL_ONLY_FOLDERS,
}

function withFolders(localOnly: LocalOnlyFolders): AssetDescriptionGatherOptions {
  return { ...AT_ROOT, localOnly }
}

beforeEach(() => {
  noteFile = createTestNoteFileService()
  readNoteMock = vi.spyOn(noteFile, 'readLocal')
  assetText = createAssetDescriptionText({ noteFile, assetStore: createTestAssetStoreService() })
})

/** An asset description service whose OCR cache holds `entries`, keyed by asset path. */
async function withOcrCache(entries: Record<string, object>): Promise<AssetDescriptionText> {
  const ocrCache: Record<string, string> = {}
  for (const [assetPath, entry] of Object.entries(entries)) {
    ocrCache[await sha256Hex(assetPath)] = JSON.stringify(entry)
  }
  return createAssetDescriptionText({
    noteFile,
    assetStore: createTestAssetStoreService({ ocrCache }),
  })
}

describe('local-only assets', () => {
  it('folds local-only attachment text while retaining device-only provenance', async () => {
    noteFile.set('finance/secure/scan.png.reflect.md', 'Account number 1234.\n')
    noteFile.set('assets/a.png.reflect.md', 'Public diagram.\n')
    const secure = withFolders(createLocalOnlyFolders(['secure']))

    const text = await assetText.gatherText(['finance/secure/scan.png', 'assets/a.png'], secure)

    expect(text).toBe('Account number 1234.\n\nPublic diagram.')
    expect(
      (await assetText.gatherBodies(['finance/secure/scan.png'], secure)).bodies[0]?.deviceOnly,
    ).toBe(true)
  })

  it('retains Rust local-only provenance despite a different path spelling', async () => {
    // e.g. a case-folded spelling the name check cannot see: the file service
    // (Rust) resolves `ſecure` into the local-only folder, the folders the
    // gather is told about name only `secure`.
    noteFile = createTestNoteFileService({ localOnly: createLocalOnlyFolders(['\u{17F}ecure']) })
    assetText = createAssetDescriptionText({ noteFile, assetStore: createTestAssetStoreService() })
    noteFile.set('people/\u{17F}ecure/scan.png.reflect.md', 'Passport scan.\n')

    const { bodies } = await assetText.gatherBodies(
      ['people/\u{17F}ecure/scan.png'],
      withFolders(createLocalOnlyFolders(['secure'])),
    )

    expect(bodies).toEqual([
      { assetPath: 'people/\u{17F}ecure/scan.png', body: 'Passport scan.', deviceOnly: true },
    ])
  })

  it('folds the same description when nothing is local-only (control)', async () => {
    noteFile.set('finance/secure/scan.png.reflect.md', 'Account number 1234.\n')
    expect(await assetText.gatherText(['finance/secure/scan.png'], AT_ROOT)).toBe(
      'Account number 1234.',
    )
    expect((await assetText.gatherBodies(['finance/secure/scan.png'], AT_ROOT)).bodies).toEqual([
      { assetPath: 'finance/secure/scan.png', body: 'Account number 1234.' },
    ])
  })
})

describe('AssetDescriptionText.gatherText', () => {
  it('returns empty for no assets', async () => {
    expect(await assetText.gatherText([], AT_ROOT)).toBe('')
  })

  it('reads each asset description body, stripping frontmatter, joined', async () => {
    noteFile.set(
      'assets/a.png.reflect.md',
      '---\nreflectAsset: true\nsource: assets/a.png\n---\n\nA flow diagram of the pipeline.\n',
    )
    noteFile.set('assets/b.pdf.reflect.md', '---\nreflectAsset: true\n---\n\nQ4 revenue report.\n')

    const text = await assetText.gatherText(['assets/a.png', 'assets/b.pdf'], AT_ROOT)

    expect(text).toBe('A flow diagram of the pipeline.\n\nQ4 revenue report.')
    expect(text).not.toContain('reflectAsset')
  })

  it('skips assets with no description file', async () => {
    noteFile.set('assets/a.png.reflect.md', '---\nreflectAsset: true\n---\n\nDescribed.\n')
    // assets/b.pdf has no description yet
    expect(await assetText.gatherText(['assets/a.png', 'assets/b.pdf'], AT_ROOT)).toBe('Described.')
  })

  it('folds an asset referenced twice only once', async () => {
    noteFile.set('assets/a.png.reflect.md', '---\nreflectAsset: true\n---\n\nOnce.\n')
    expect(await assetText.gatherText(['assets/a.png', 'assets/a.png'], AT_ROOT)).toBe('Once.')
    expect(readNoteMock).toHaveBeenCalledTimes(1)
  })

  it('also folds a user-authored description file (no managed marker)', async () => {
    noteFile.set(
      'assets/a.png.reflect.md',
      '# My own caption\n\nHand-written notes about this image.\n',
    )
    const text = await assetText.gatherText(['assets/a.png'], AT_ROOT)
    expect(text).toContain('Hand-written notes about this image.')
  })

  it('caps the combined text', async () => {
    noteFile.set('assets/a.png.reflect.md', 'x'.repeat(MAX_ASSET_TEXT_CHARS + 5_000))
    const text = await assetText.gatherText(['assets/a.png'], AT_ROOT)
    expect(text.length).toBe(MAX_ASSET_TEXT_CHARS)
  })

  it('skips an iCloud-evicted description instead of forcing a download', async () => {
    noteFile.set('assets/b.pdf.reflect.md', '---\nreflectAsset: true\n---\n\nStill local.\n')
    noteFile.set('assets/a.png.reflect.md', 'Not local.')
    noteFile.evict('assets/a.png.reflect.md')
    const text = await assetText.gatherText(['assets/a.png', 'assets/b.pdf'], AT_ROOT)
    expect(text).toBe('Still local.')
  })

  it('skips an asset whose description path resolves outside the graph', async () => {
    noteFile.set('assets/b.pdf.reflect.md', '---\nreflectAsset: true\n---\n\nStill indexed.\n')
    readNoteMock.mockRejectedValueOnce(
      new AppError('traversal', 'path resolves outside the graph: "raw/a.png.reflect.md"'),
    )
    expect(await assetText.gatherText(['raw/a.png', 'assets/b.pdf'], AT_ROOT)).toBe(
      'Still indexed.',
    )
  })

  it('propagates a non-notFound read error', async () => {
    readNoteMock.mockRejectedValueOnce(new AppError('io', 'disk error'))
    await expect(assetText.gatherText(['assets/a.png'], AT_ROOT)).rejects.toMatchObject({
      kind: 'io',
    })
  })
})

describe('AssetDescriptionText.gatherBodies', () => {
  it('resolves a bare wiki attachment before folding device-only OCR', async () => {
    noteFile.set('media/scan.png', 'png')
    const withOcr = await withOcrCache({
      'media/scan.png': {
        version: 1,
        status: 'complete',
        deviceOnly: true,
        assetPath: 'media/scan.png',
        sourceHash: 'a'.repeat(64),
        sourceSize: 2,
        providerId: 'local',
        model: 'vision',
        baseUrl: 'http://localhost:1234/v1',
        pages: 1,
        generatedAt: '2026-10-04T00:00:00.000Z',
        body: 'OCR sentinel',
      },
    })

    expect((await withOcr.gatherBodies(['scan.png'], AT_ROOT)).bodies).toEqual([
      { assetPath: 'media/scan.png', body: 'OCR sentinel', deviceOnly: true },
    ])
  })

  it('blocks an old managed caption after local OCR invalidation', async () => {
    const withOcr = await withOcrCache({
      'assets/a.png': {
        version: 1,
        status: 'invalid',
        deviceOnly: true,
        assetPath: 'assets/a.png',
      },
    })
    noteFile.set('assets/a.png.reflect.md', '---\nreflectAsset: true\n---\nStale caption')
    expect((await withOcr.gatherBodies(['assets/a.png'], AT_ROOT)).bodies).toEqual([])
    noteFile.set('assets/a.png.reflect.md', 'My own current caption')
    expect((await withOcr.gatherBodies(['assets/a.png'], AT_ROOT)).bodies).toEqual([
      { assetPath: 'assets/a.png', body: 'My own current caption' },
    ])
  })

  it('retains private sidecar provenance when the referencing note is public', async () => {
    noteFile.set('assets/a.png.reflect.md', '---\nprivate: true\n---\nPrivate caption')
    expect((await assetText.gatherBodies(['assets/a.png'], AT_ROOT)).bodies).toEqual([
      { assetPath: 'assets/a.png', body: 'Private caption', deviceOnly: true },
    ])
  })

  it('returns per-asset bodies attributed to their asset paths', async () => {
    noteFile.set('assets/a.png.reflect.md', '---\nreflectAsset: true\n---\n\nA flow diagram.\n')
    noteFile.set('assets/b.pdf.reflect.md', '---\nreflectAsset: true\n---\n\nQ4 revenue report.\n')

    const { bodies, evicted } = await assetText.gatherBodies(
      ['assets/a.png', 'assets/b.pdf'],
      AT_ROOT,
    )

    expect(bodies).toEqual([
      { assetPath: 'assets/a.png', body: 'A flow diagram.' },
      { assetPath: 'assets/b.pdf', body: 'Q4 revenue report.' },
    ])
    expect(evicted).toEqual([])
  })

  it('skips missing descriptions, empty bodies, and repeated assets', async () => {
    noteFile.set('assets/a.png.reflect.md', '---\nreflectAsset: true\n---\n\nDescribed.\n')
    noteFile.set('assets/empty.png.reflect.md', '---\nreflectAsset: true\n---\n\n  \n')

    const { bodies } = await assetText.gatherBodies(
      ['assets/a.png', 'assets/a.png', 'assets/empty.png', 'assets/missing.pdf'],
      AT_ROOT,
    )

    expect(bodies).toEqual([{ assetPath: 'assets/a.png', body: 'Described.' }])
    expect(readNoteMock).toHaveBeenCalledTimes(3) // the repeat never re-reads
  })

  it('stops accumulating once the combined length reaches the cap', async () => {
    noteFile.set('assets/a.png.reflect.md', 'x'.repeat(MAX_ASSET_TEXT_CHARS))
    noteFile.set('assets/b.png.reflect.md', 'never reached')

    const { bodies } = await assetText.gatherBodies(['assets/a.png', 'assets/b.png'], AT_ROOT)

    expect(bodies).toHaveLength(1)
    expect(bodies[0]!.assetPath).toBe('assets/a.png')
  })

  it('reports an evicted sidecar so full-replace consumers can skip the write', async () => {
    noteFile.set('assets/b.pdf.reflect.md', '---\nreflectAsset: true\n---\n\nStill local.\n')
    noteFile.set('assets/a.png.reflect.md', 'Not local.')
    noteFile.evict('assets/a.png.reflect.md')

    const { bodies, evicted } = await assetText.gatherBodies(
      ['assets/a.png', 'assets/b.pdf'],
      AT_ROOT,
    )

    expect(bodies).toEqual([{ assetPath: 'assets/b.pdf', body: 'Still local.' }])
    expect(evicted).toEqual(['assets/a.png'])
  })
})
