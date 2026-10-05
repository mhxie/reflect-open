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
})
