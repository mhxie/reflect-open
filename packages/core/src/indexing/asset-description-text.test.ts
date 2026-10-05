import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readNoteLocal, readAssetOcrCache, listAttachments } from '../graph/commands.ts'
import { setLocalOnlyFolders } from '../graph/local-only.ts'
import {
  gatherAssetDescriptionBodies,
  gatherAssetDescriptionText,
  MAX_ASSET_TEXT_CHARS,
} from './asset-description-text.ts'

vi.mock('../graph/commands', () => ({
  readNoteLocal: vi.fn(),
  readAssetOcrCache: vi.fn(),
  listAttachments: vi.fn(),
}))

const readNoteMock = vi.mocked(readNoteLocal)

const notFound = (): unknown => ({ kind: 'notFound', message: 'missing' })

/** Description files keyed by their `.reflect.md` path. */
const files = new Map<string, string>()
/** Sidecar paths Rust resolves into a local-only folder. */
const resolvedLocalOnly = new Set<string>()

beforeEach(() => {
  files.clear()
  resolvedLocalOnly.clear()
  setLocalOnlyFolders([])
  vi.clearAllMocks()
  vi.mocked(readAssetOcrCache).mockRejectedValue(notFound())
  vi.mocked(listAttachments).mockResolvedValue([])
  readNoteMock.mockImplementation(async (path: string) => {
    const value = files.get(path)
    if (value === undefined) {
      throw notFound()
    }
    return { kind: 'content', content: value, localOnly: resolvedLocalOnly.has(path) }
  })
})

describe('local-only assets', () => {
  it('folds local-only attachment text while retaining device-only provenance', async () => {
    files.set('finance/secure/scan.png.reflect.md', 'Account number 1234.\n')
    files.set('assets/a.png.reflect.md', 'Public diagram.\n')
    setLocalOnlyFolders(['secure'])

    const text = await gatherAssetDescriptionText(['finance/secure/scan.png', 'assets/a.png'])

    expect(text).toBe('Account number 1234.\n\nPublic diagram.')
    expect(
      (await gatherAssetDescriptionBodies(['finance/secure/scan.png'])).bodies[0]?.deviceOnly,
    ).toBe(true)
  })

  it('retains Rust local-only provenance despite a different path spelling', async () => {
    // e.g. a case-folded spelling the name check cannot see.
    files.set('people/\u{17F}ecure/scan.png.reflect.md', 'Passport scan.\n')
    resolvedLocalOnly.add('people/\u{17F}ecure/scan.png.reflect.md')
    setLocalOnlyFolders(['secure'])

    expect((await gatherAssetDescriptionBodies(['people/\u{17F}ecure/scan.png'])).bodies).toEqual([
      { assetPath: 'people/\u{17F}ecure/scan.png', body: 'Passport scan.', deviceOnly: true },
    ])
  })

  it('folds the same description when nothing is local-only (control)', async () => {
    files.set('finance/secure/scan.png.reflect.md', 'Account number 1234.\n')
    expect(await gatherAssetDescriptionText(['finance/secure/scan.png'])).toBe(
      'Account number 1234.',
    )
  })
})

describe('gatherAssetDescriptionText', () => {
  it('returns empty for no assets', async () => {
    expect(await gatherAssetDescriptionText([])).toBe('')
  })

  it('reads each asset description body, stripping frontmatter, joined', async () => {
    files.set(
      'assets/a.png.reflect.md',
      '---\nreflectAsset: true\nsource: assets/a.png\n---\n\nA flow diagram of the pipeline.\n',
    )
    files.set('assets/b.pdf.reflect.md', '---\nreflectAsset: true\n---\n\nQ4 revenue report.\n')

    const text = await gatherAssetDescriptionText(['assets/a.png', 'assets/b.pdf'])

    expect(text).toBe('A flow diagram of the pipeline.\n\nQ4 revenue report.')
    expect(text).not.toContain('reflectAsset')
  })

  it('skips assets with no description file', async () => {
    files.set('assets/a.png.reflect.md', '---\nreflectAsset: true\n---\n\nDescribed.\n')
    // assets/b.pdf has no description yet
    expect(await gatherAssetDescriptionText(['assets/a.png', 'assets/b.pdf'])).toBe('Described.')
  })

  it('folds an asset referenced twice only once', async () => {
    files.set('assets/a.png.reflect.md', '---\nreflectAsset: true\n---\n\nOnce.\n')
    expect(await gatherAssetDescriptionText(['assets/a.png', 'assets/a.png'])).toBe('Once.')
    expect(readNoteMock).toHaveBeenCalledTimes(1)
  })

  it('also folds a user-authored description file (no managed marker)', async () => {
    files.set(
      'assets/a.png.reflect.md',
      '# My own caption\n\nHand-written notes about this image.\n',
    )
    const text = await gatherAssetDescriptionText(['assets/a.png'])
    expect(text).toContain('Hand-written notes about this image.')
  })

  it('caps the combined text', async () => {
    files.set('assets/a.png.reflect.md', 'x'.repeat(MAX_ASSET_TEXT_CHARS + 5_000))
    const text = await gatherAssetDescriptionText(['assets/a.png'])
    expect(text.length).toBe(MAX_ASSET_TEXT_CHARS)
  })

  it('skips an iCloud-evicted description instead of forcing a download', async () => {
    files.set('assets/b.pdf.reflect.md', '---\nreflectAsset: true\n---\n\nStill local.\n')
    readNoteMock.mockResolvedValueOnce({ kind: 'evicted' }) // assets/a.png's sidecar
    const text = await gatherAssetDescriptionText(['assets/a.png', 'assets/b.pdf'])
    expect(text).toBe('Still local.')
  })

  it('skips an asset whose description path resolves outside the graph', async () => {
    files.set('assets/b.pdf.reflect.md', '---\nreflectAsset: true\n---\n\nStill indexed.\n')
    readNoteMock.mockRejectedValueOnce({
      kind: 'traversal',
      message: 'path resolves outside the graph: "raw/a.png.reflect.md"',
    })
    expect(await gatherAssetDescriptionText(['raw/a.png', 'assets/b.pdf'])).toBe('Still indexed.')
  })

  it('propagates a non-notFound read error', async () => {
    readNoteMock.mockRejectedValueOnce({ kind: 'io', message: 'disk error' })
    await expect(gatherAssetDescriptionText(['assets/a.png'])).rejects.toMatchObject({ kind: 'io' })
  })
})

describe('gatherAssetDescriptionBodies', () => {
  it('resolves a bare wiki attachment before folding device-only OCR', async () => {
    vi.mocked(listAttachments).mockResolvedValue([
      { path: 'media/scan.png', size: 2, modifiedMs: 1 },
    ])
    vi.mocked(readAssetOcrCache).mockResolvedValue(
      JSON.stringify({
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
      }),
    )
    expect((await gatherAssetDescriptionBodies(['scan.png'], 'notes/a.md')).bodies).toEqual([
      { assetPath: 'media/scan.png', body: 'OCR sentinel', deviceOnly: true },
    ])
  })

  it('blocks an old managed caption after local OCR invalidation', async () => {
    vi.mocked(readAssetOcrCache).mockResolvedValue(
      JSON.stringify({
        version: 1,
        status: 'invalid',
        deviceOnly: true,
        assetPath: 'assets/a.png',
      }),
    )
    files.set('assets/a.png.reflect.md', '---\nreflectAsset: true\n---\nStale caption')
    expect((await gatherAssetDescriptionBodies(['assets/a.png'])).bodies).toEqual([])
    files.set('assets/a.png.reflect.md', 'My own current caption')
    expect((await gatherAssetDescriptionBodies(['assets/a.png'])).bodies).toEqual([
      { assetPath: 'assets/a.png', body: 'My own current caption' },
    ])
  })

  it('retains private sidecar provenance when the referencing note is public', async () => {
    files.set('assets/a.png.reflect.md', '---\nprivate: true\n---\nPrivate caption')
    expect((await gatherAssetDescriptionBodies(['assets/a.png'])).bodies).toEqual([
      { assetPath: 'assets/a.png', body: 'Private caption', deviceOnly: true },
    ])
  })

  it('returns per-asset bodies attributed to their asset paths', async () => {
    files.set('assets/a.png.reflect.md', '---\nreflectAsset: true\n---\n\nA flow diagram.\n')
    files.set('assets/b.pdf.reflect.md', '---\nreflectAsset: true\n---\n\nQ4 revenue report.\n')

    const { bodies, evicted } = await gatherAssetDescriptionBodies(['assets/a.png', 'assets/b.pdf'])

    expect(bodies).toEqual([
      { assetPath: 'assets/a.png', body: 'A flow diagram.' },
      { assetPath: 'assets/b.pdf', body: 'Q4 revenue report.' },
    ])
    expect(evicted).toEqual([])
  })

  it('skips missing descriptions, empty bodies, and repeated assets', async () => {
    files.set('assets/a.png.reflect.md', '---\nreflectAsset: true\n---\n\nDescribed.\n')
    files.set('assets/empty.png.reflect.md', '---\nreflectAsset: true\n---\n\n  \n')

    const { bodies } = await gatherAssetDescriptionBodies([
      'assets/a.png',
      'assets/a.png',
      'assets/empty.png',
      'assets/missing.pdf',
    ])

    expect(bodies).toEqual([{ assetPath: 'assets/a.png', body: 'Described.' }])
    expect(readNoteMock).toHaveBeenCalledTimes(3) // the repeat never re-reads
  })

  it('stops accumulating once the combined length reaches the cap', async () => {
    files.set('assets/a.png.reflect.md', 'x'.repeat(MAX_ASSET_TEXT_CHARS))
    files.set('assets/b.png.reflect.md', 'never reached')

    const { bodies } = await gatherAssetDescriptionBodies(['assets/a.png', 'assets/b.png'])

    expect(bodies).toHaveLength(1)
    expect(bodies[0]!.assetPath).toBe('assets/a.png')
  })

  it('reports an evicted sidecar so full-replace consumers can skip the write', async () => {
    files.set('assets/b.pdf.reflect.md', '---\nreflectAsset: true\n---\n\nStill local.\n')
    readNoteMock.mockResolvedValueOnce({ kind: 'evicted' }) // assets/a.png's sidecar

    const { bodies, evicted } = await gatherAssetDescriptionBodies(['assets/a.png', 'assets/b.pdf'])

    expect(bodies).toEqual([{ assetPath: 'assets/b.pdf', body: 'Still local.' }])
    expect(evicted).toEqual(['assets/a.png'])
  })
})
