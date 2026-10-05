import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  listAssetOcrCacheKeys,
  listAttachments,
  readAssetForDevice,
  readAssetOcrCache,
  writeAssetOcrCache,
} from '../graph/commands.ts'
import { hashBytes, hashContent } from '../indexing/hash.ts'
import { reconcileCachedAssetOcr } from './asset-ocr-maintenance.ts'

vi.mock('../graph/commands', () => ({
  listAssetOcrCacheKeys: vi.fn(),
  listAttachments: vi.fn(),
  readAssetForDevice: vi.fn(),
  readAssetOcrCache: vi.fn(),
  writeAssetOcrCache: vi.fn(),
}))

const PATH = 'secure/scan.png'
const original = new Uint8Array([1, 2])

beforeEach(async () => {
  vi.resetAllMocks()
  vi.mocked(listAttachments).mockResolvedValue([{ path: PATH, size: 2, modifiedMs: 1 }])
  vi.mocked(listAssetOcrCacheKeys).mockResolvedValue([await hashContent(PATH)])
  vi.mocked(readAssetForDevice).mockResolvedValue(original)
  vi.mocked(readAssetOcrCache).mockResolvedValue(
    JSON.stringify({
      version: 1,
      status: 'complete',
      deviceOnly: true,
      assetPath: PATH,
      sourceHash: await hashBytes(original),
      sourceSize: 2,
      providerId: 'local',
      model: 'vision',
      baseUrl: 'http://localhost:1234/v1',
      pages: 1,
      generatedAt: '2026-10-04T00:00:00.000Z',
      body: 'Private OCR',
    }),
  )
})

describe('local OCR maintenance', () => {
  it('reindexes a valid cached source on open without regenerating OCR', async () => {
    expect(await reconcileCachedAssetOcr(7)).toEqual([PATH])
    expect(writeAssetOcrCache).not.toHaveBeenCalled()
    expect(readAssetForDevice).toHaveBeenCalledWith(PATH, 7)
  })

  it('invalidates source replacements even when metadata stays unchanged', async () => {
    vi.mocked(readAssetForDevice).mockResolvedValue(new Uint8Array([3, 4]))
    expect(await reconcileCachedAssetOcr(7, ['scan.png'])).toEqual([PATH])
    expect(writeAssetOcrCache).toHaveBeenCalledWith(
      await hashContent(PATH),
      JSON.stringify({
        version: 1,
        status: 'invalid',
        deviceOnly: true,
        assetPath: PATH,
      }),
      7,
    )
  })

  it('recovers deleted sources from cache inventory and preserves their privacy marker', async () => {
    vi.mocked(listAttachments).mockResolvedValue([])
    vi.mocked(readAssetForDevice).mockRejectedValue({ kind: 'notFound', message: 'deleted' })
    expect(await reconcileCachedAssetOcr(7)).toEqual([PATH])
    expect(writeAssetOcrCache).toHaveBeenCalledTimes(1)
  })

  it('keeps invalidated sources available for reindex retries after reopening', async () => {
    vi.mocked(readAssetOcrCache).mockResolvedValue(
      JSON.stringify({ version: 1, status: 'invalid', deviceOnly: true, assetPath: PATH }),
    )
    expect(await reconcileCachedAssetOcr(7)).toEqual([PATH])
    expect(readAssetForDevice).not.toHaveBeenCalled()
  })

  it('reports only sources it invalidates on a wake scan', async () => {
    expect(await reconcileCachedAssetOcr(7, undefined, { reindexCached: false })).toEqual([])
    expect(readAssetForDevice).toHaveBeenCalledWith(PATH, 7)

    vi.mocked(readAssetForDevice).mockResolvedValue(new Uint8Array([3, 4]))
    expect(await reconcileCachedAssetOcr(7, undefined, { reindexCached: false })).toEqual([PATH])
  })

  it('does not re-report an already invalidated source on a wake scan', async () => {
    vi.mocked(readAssetOcrCache).mockResolvedValue(
      JSON.stringify({ version: 1, status: 'invalid', deviceOnly: true, assetPath: PATH }),
    )
    expect(await reconcileCachedAssetOcr(7, undefined, { reindexCached: false })).toEqual([])
  })

  describe('wake scans', () => {
    const NOW = 1_000_000

    beforeEach(async () => {
      vi.mocked(listAttachments).mockResolvedValue([
        { path: PATH, size: 2, modifiedMs: NOW - 60_000 },
      ])
      const cache = JSON.parse(await vi.mocked(readAssetOcrCache)('key', 7))
      vi.mocked(readAssetOcrCache).mockResolvedValue(
        JSON.stringify({ ...cache, sourceModifiedMs: NOW - 60_000 }),
      )
    })

    it('skips re-reading a source whose recorded size and mtime still match', async () => {
      const options = { reindexCached: false, trustUnchangedStat: true, now: () => NOW }
      expect(await reconcileCachedAssetOcr(7, undefined, options)).toEqual([])
      expect(readAssetForDevice).not.toHaveBeenCalled()
    })

    it('re-hashes a source whose mtime moved', async () => {
      vi.mocked(listAttachments).mockResolvedValue([
        { path: PATH, size: 2, modifiedMs: NOW - 1_000_000 },
      ])
      vi.mocked(readAssetForDevice).mockResolvedValue(new Uint8Array([3, 4]))
      const options = { reindexCached: false, trustUnchangedStat: true, now: () => NOW }
      expect(await reconcileCachedAssetOcr(7, undefined, options)).toEqual([PATH])
      expect(writeAssetOcrCache).toHaveBeenCalledTimes(1)
    })

    it('still re-hashes reported changes even when the metadata matches', async () => {
      vi.mocked(readAssetForDevice).mockResolvedValue(new Uint8Array([3, 4]))
      expect(await reconcileCachedAssetOcr(7, [PATH], { now: () => NOW })).toEqual([PATH])
    })
  })

  it('keeps OCR for an evicted source without reading it', async () => {
    vi.mocked(listAttachments).mockResolvedValue([
      { path: PATH, size: 2, modifiedMs: 1, placeholder: true },
    ])
    expect(await reconcileCachedAssetOcr(7, undefined, { reindexCached: false })).toEqual([])
    expect(readAssetForDevice).not.toHaveBeenCalled()
    expect(writeAssetOcrCache).not.toHaveBeenCalled()
  })

  it('skips an unreadable source and goes on with the rest of the scan', async () => {
    const other = 'secure/other.png'
    vi.mocked(listAssetOcrCacheKeys).mockResolvedValue([
      await hashContent(PATH),
      await hashContent(other),
    ])
    const cache = JSON.parse(await vi.mocked(readAssetOcrCache)('key', 7))
    vi.mocked(readAssetOcrCache).mockImplementation(async (key) =>
      JSON.stringify(key === (await hashContent(other)) ? { ...cache, assetPath: other } : cache),
    )
    vi.mocked(readAssetForDevice).mockImplementation(async (path) => {
      if (path === PATH) throw { kind: 'io', message: 'the file is not available offline' }
      return new Uint8Array([3, 4])
    })
    expect(await reconcileCachedAssetOcr(7, undefined, { reindexCached: false })).toEqual([other])
  })
})
