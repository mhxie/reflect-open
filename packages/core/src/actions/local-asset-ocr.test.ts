import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { MockLanguageModelV3 } from '@reflect/modules/ai/test'
import { describeAsset } from '../ai/describe-asset.ts'
import { languageModelFor } from '../ai/language-model.ts'
import { aiApiKeyForConfig } from '../ai/secrets.ts'
import {
  listAttachments,
  pdfInfoForDevice,
  localOcrSupported,
  readAssetForDevice,
  readAssetOcrCache,
  readNoteForDevice,
  readPdfPageForDevice,
  writeAssetOcrCache,
} from '../graph/commands.ts'
import {
  connectIndex,
  openMigratedIndex,
  applyProjection,
  project,
} from '../indexing/flow-test-harness.ts'
import { setBridge } from '../ipc/bridge.ts'
import { verifyOnDeviceServer } from '../privacy/on-device.ts'
import { testTargetModel } from '../testing/target-model.ts'
import type { OpenAiCompatibleProviderConfig } from '../settings/schema.ts'
import { assetOcrCacheSchema } from './asset-ocr-cache.ts'
import { reconcileAssetDescriptions } from './asset-description.ts'

vi.mock('../graph/commands', async (original) => ({
  ...(await original<typeof import('../graph/commands.ts')>()),
  listAttachments: vi.fn(),
  pdfInfoForDevice: vi.fn(),
  localOcrSupported: vi.fn(),
  readAssetForDevice: vi.fn(),
  readAssetOcrCache: vi.fn(),
  readNoteForDevice: vi.fn(),
  readPdfPageForDevice: vi.fn(),
  writeAssetOcrCache: vi.fn(),
}))
vi.mock('../ai/describe-asset', async (original) => ({
  ...(await original<typeof import('../ai/describe-asset.ts')>()),
  describeAsset: vi.fn(),
}))
vi.mock('../ai/language-model', async (original) => ({
  ...(await original<typeof import('../ai/language-model.ts')>()),
  languageModelFor: vi.fn(),
}))
vi.mock('../ai/secrets', () => ({ aiApiKeyForConfig: vi.fn() }))
vi.mock('../privacy/on-device-verification', () => ({ verifyOnDeviceServer: vi.fn() }))

const config: OpenAiCompatibleProviderConfig = {
  id: 'vision',
  provider: 'openai-compatible',
  model: 'vision:latest',
  baseUrl: 'http://localhost:11434/v1',
  keyHint: '',
  supportsImages: true,
  onDevice: { model: 'vision:latest', baseUrl: 'http://localhost:11434/v1', server: 'ollama' },
}
let database: DatabaseSync

beforeEach(() => {
  vi.resetAllMocks()
  database = openMigratedIndex()
  applyProjection(
    database,
    project('notes/private.md', '---\nprivate: true\n---\n# Private\n![scan](assets/scan.pdf)', 1),
  )
  database
    .prepare('INSERT INTO assets(note_path, asset_path) VALUES (?, ?)')
    .run('notes/private.md', 'assets/scan.pdf')
  connectIndex(database)
  vi.mocked(aiApiKeyForConfig).mockResolvedValue('')
  vi.mocked(verifyOnDeviceServer).mockResolvedValue('ok')
  vi.mocked(languageModelFor).mockImplementation(async (target) =>
    testTargetModel(target, new MockLanguageModelV3()),
  )
  vi.mocked(listAttachments).mockResolvedValue([])
  vi.mocked(readAssetForDevice).mockResolvedValue(new Uint8Array([1, 2, 3]))
  vi.mocked(readAssetOcrCache).mockRejectedValue({ kind: 'notFound', message: 'No OCR' })
  vi.mocked(readNoteForDevice).mockRejectedValue({ kind: 'notFound', message: 'No sidecar' })
  vi.mocked(localOcrSupported).mockResolvedValue({ cache: true, pdf: true })
  vi.mocked(pdfInfoForDevice).mockResolvedValue({
    pages: [
      { width: 100, height: 200 },
      { width: 100, height: 200 },
    ],
  })
  vi.mocked(readPdfPageForDevice).mockResolvedValue(new Uint8Array([4, 5]))
  vi.mocked(describeAsset).mockResolvedValue('Recognized private text')
})

afterEach(() => {
  setBridge(null)
  database.close()
})

function run(provider = config) {
  return reconcileAssetDescriptions({
    providers: { providers: [provider], defaultProviderId: provider.id },
    localOcrProviderId: 'vision',
    generation: 7,
    mode: 'backfill',
  })
}

describe('local OCR', () => {
  it('refuses an unsupported cache platform before reading private attachment bytes', async () => {
    vi.mocked(localOcrSupported).mockResolvedValue({ cache: false, pdf: false })
    expect((await run()).stopped?.reason).toBe('unsupported')
    expect(readAssetForDevice).not.toHaveBeenCalled()
    expect(describeAsset).not.toHaveBeenCalled()
  })

  it('reads every PDF page with the verified local model and caches one complete device-only result', async () => {
    const outcome = await run()
    expect(outcome.describedAssetPaths).toEqual(['assets/scan.pdf'])
    expect(readPdfPageForDevice).toHaveBeenNthCalledWith(
      1,
      'assets/scan.pdf',
      1,
      7,
      expect.stringMatching(/^[a-f\d]{64}$/u),
    )
    expect(readPdfPageForDevice).toHaveBeenNthCalledWith(
      2,
      'assets/scan.pdf',
      2,
      7,
      vi.mocked(readPdfPageForDevice).mock.calls[0]?.[3],
    )
    const request = vi.mocked(describeAsset).mock.calls[0]?.[0]
    expect(request?.localModel?.target.kind).toBe('on-device')
    expect(request?.mediaType).toBe('image/png')
    const stored = assetOcrCacheSchema.parse(
      JSON.parse(String(vi.mocked(writeAssetOcrCache).mock.calls[0]?.[1])),
    )
    expect(stored).toMatchObject({
      status: 'complete',
      deviceOnly: true,
      pages: 2,
      model: config.model,
    })
    expect(stored.body).toContain('## Page 2')
    expect(writeAssetOcrCache).toHaveBeenCalledTimes(1)
  })

  it('never caches a partially recognized PDF', async () => {
    vi.mocked(describeAsset)
      .mockResolvedValueOnce('First page')
      .mockRejectedValueOnce(new Error('Model stopped'))
    expect((await run()).stopped?.message).toBe('Model stopped')
    expect(writeAssetOcrCache).not.toHaveBeenCalled()
  })

  it('refuses before reading private bytes when verification fails', async () => {
    vi.mocked(verifyOnDeviceServer).mockResolvedValue({ kind: 'refused', reason: 'Remote alias' })
    expect((await run()).stopped?.message).toBe('Remote alias')
    expect(readAssetForDevice).not.toHaveBeenCalled()
    expect(describeAsset).not.toHaveBeenCalled()
  })

  it('never falls back when the selected local model is unavailable or lacks vision', async () => {
    expect((await run({ ...config, supportsImages: false })).stopped?.reason).toBe('config')
    expect(describeAsset).not.toHaveBeenCalled()
  })

  it('discards OCR when the source changed while the model was reading it', async () => {
    vi.mocked(readAssetForDevice)
      .mockResolvedValueOnce(new Uint8Array([1]))
      .mockResolvedValueOnce(new Uint8Array([2]))
    expect((await run()).skippedChanged).toBe(1)
    expect(writeAssetOcrCache).not.toHaveBeenCalled()
  })

  it('preserves user-authored sidecars without reading the source', async () => {
    vi.mocked(readNoteForDevice).mockResolvedValue({ content: 'User caption', localOnly: false })
    expect((await run()).skippedUserAuthored).toBe(1)
    expect(readAssetForDevice).not.toHaveBeenCalled()
  })

  it('records the listed mtime so wake scans can skip re-hashing an untouched source', async () => {
    vi.mocked(listAttachments).mockResolvedValue([
      { path: 'assets/scan.pdf', size: 3, modifiedMs: 1234 },
    ])
    await run()
    const stored = assetOcrCacheSchema.parse(
      JSON.parse(String(vi.mocked(writeAssetOcrCache).mock.calls[0]?.[1])),
    )
    expect(stored.sourceModifiedMs).toBe(1234)
  })

  describe('a failure confined to one attachment', () => {
    beforeEach(() => {
      database
        .prepare('INSERT INTO assets(note_path, asset_path) VALUES (?, ?)')
        .run('notes/private.md', 'assets/photo.png')
    })

    it('skips an oversize source and still recognizes the next attachment', async () => {
      vi.mocked(readAssetForDevice).mockImplementation(async (path) => {
        if (path === 'assets/scan.pdf') {
          throw { kind: 'unsupported', message: 'source exceeds 20971520 bytes' }
        }
        return new Uint8Array([9])
      })
      const outcome = await run()
      expect(outcome.stopped).toBeNull()
      expect(outcome.skippedOversize).toBe(1)
      expect(outcome.describedAssetPaths).toEqual(['assets/photo.png'])
    })

    it('skips an offline source and a blank page instead of stopping the pass', async () => {
      vi.mocked(readAssetForDevice).mockImplementation(async (path) => {
        if (path === 'assets/photo.png') {
          throw { kind: 'io', message: 'the file is not available offline' }
        }
        return new Uint8Array([1])
      })
      vi.mocked(describeAsset).mockResolvedValue('   ')
      const outcome = await run()
      expect(outcome.stopped).toBeNull()
      expect(outcome.refused).toBe(2)
      expect(writeAssetOcrCache).not.toHaveBeenCalled()
    })

    it('skips PDFs where pages cannot render, without reading their bytes', async () => {
      vi.mocked(localOcrSupported).mockResolvedValue({ cache: true, pdf: false })
      const outcome = await run()
      expect(outcome.stopped).toBeNull()
      expect(outcome.skippedOversize).toBe(1)
      expect(readAssetForDevice).not.toHaveBeenCalledWith('assets/scan.pdf', 7)
      expect(pdfInfoForDevice).not.toHaveBeenCalled()
      expect(outcome.describedAssetPaths).toEqual(['assets/photo.png'])
    })

    it('still stops the whole pass when the local server is unavailable', async () => {
      vi.mocked(describeAsset).mockRejectedValue({ kind: 'network', message: 'Server down' })
      const outcome = await run()
      expect(outcome.stopped).toMatchObject({ reason: 'network', message: 'Server down' })
      expect(describeAsset).toHaveBeenCalledTimes(1)
    })
  })
})
