import { sha256Hex } from '@reflect/utils'
import { describe, expect, it, vi } from 'vitest'
import { createAiCredentialService } from '../ai/ai-credential-service.ts'
import { createAiProviderConfigService } from '../ai/ai-provider-config-service.ts'
import { AppError } from '../errors.ts'
import type { LocalOcrSupport } from '../graph/asset-store-service.ts'
import type { OpenAiCompatibleProviderConfig } from '../settings/schema.ts'
import {
  createNodeTestDatabaseService,
  createTestAiKeyValidationService,
  createTestAssetDescriberService,
  createTestAssetStoreService,
  createTestClockService,
  createTestIdService,
  createTestLanguageModelService,
  createTestNoteFileService,
  createTestOnDeviceModelService,
  createTestSecretStoreService,
  createTestSettingsService,
  seedNotes,
} from '../testing/index.ts'
import { assetOcrCacheSchema, type AssetOcrCache } from './asset-ocr-cache.ts'
import { createLocalAssetOcrService } from './local-asset-ocr-service.ts'

const CONFIG: OpenAiCompatibleProviderConfig = {
  id: 'vision',
  provider: 'openai-compatible',
  model: 'vision:latest',
  baseUrl: 'http://localhost:11434/v1',
  keyHint: '',
  supportsImages: true,
  onDevice: { model: 'vision:latest', baseUrl: 'http://localhost:11434/v1', server: 'ollama' },
}

const GENERATION = 7
const NOW = Date.parse('2026-10-04T00:00:00.000Z')

/**
 * The local OCR pass over test doubles: a private note at the graph root
 * referencing `assets/scan.pdf` (and `assets/photo.png` with `photo`), a
 * two-page PDF and a photo on disk, the vision model `provider` configured,
 * and a model that recognizes "Recognized private text". `notePath` moves the
 * note into a folder, where each link also reads as note-relative.
 */
async function setup(
  options: {
    provider?: OpenAiCompatibleProviderConfig
    photo?: boolean
    ocrSupport?: LocalOcrSupport
    refused?: string
    notePath?: string
  } = {},
) {
  const database = createNodeTestDatabaseService()
  seedNotes(database, [
    {
      path: options.notePath ?? 'private.md',
      markdown: `---\nprivate: true\n---\n# Private\n![scan](assets/scan.pdf)\n${
        options.photo === true ? '![photo](assets/photo.png)\n' : ''
      }`,
    },
  ])
  const assetStore = createTestAssetStoreService({
    assets: {
      'assets/scan.pdf': new Uint8Array([1, 2, 3]),
      'assets/photo.png': new Uint8Array([9]),
    },
    pdfs: {
      'assets/scan.pdf': {
        pages: [
          { width: 100, height: 200 },
          { width: 100, height: 200 },
        ],
      },
    },
    ...(options.ocrSupport === undefined ? {} : { ocrSupport: options.ocrSupport }),
  })
  const noteFile = createTestNoteFileService()
  // Rust serves any visible Markdown file to the device reads, a description
  // sidecar under `assets/` included; the double serves notes only.
  vi.spyOn(noteFile, 'readForDevice').mockImplementation((path) => {
    return Promise.try(() => {
      const content = noteFile.files().get(path)
      if (content === undefined) {
        throw new AppError('notFound', `${path} does not exist`)
      }
      return { content, localOnly: false }
    })
  })
  const provider = options.provider ?? CONFIG
  const settings = createTestSettingsService({
    aiProviders: [provider],
    defaultAiProviderId: provider.id,
  })
  await settings.whenLoaded()
  const aiCredentials = createAiCredentialService({ secretStore: createTestSecretStoreService() })
  const aiProviderConfig = createAiProviderConfigService({
    settings,
    credentials: aiCredentials,
    keyValidation: createTestAiKeyValidationService(),
    id: createTestIdService(),
  })
  const onDeviceModels = createTestOnDeviceModelService(
    options.refused === undefined ? {} : { verdict: { kind: 'refused', reason: options.refused } },
  )
  const describer = createTestAssetDescriberService('Recognized private text')
  /**
   * Every device read of an attachment's bytes, in order.
   */
  const deviceReads: string[] = []
  const readBytesForDevice = assetStore.readBytesForDevice.bind(assetStore)
  vi.spyOn(assetStore, 'readBytesForDevice').mockImplementation(async (path, generation) => {
    deviceReads.push(path)
    return await readBytesForDevice(path, generation)
  })
  const service = createLocalAssetOcrService({
    assetStore,
    noteFile,
    database,
    aiProviderConfig,
    aiCredentials,
    onDeviceModels,
    languageModel: createTestLanguageModelService(),
    assetDescriber: describer,
    clock: createTestClockService({ now: NOW }),
  })
  /**
   * The complete OCR stored for `path`, or undefined.
   */
  async function stored(path: string): Promise<AssetOcrCache | undefined> {
    const entry = assetStore.ocrCache().get(await sha256Hex(path))
    return entry === undefined ? undefined : assetOcrCacheSchema.parse(JSON.parse(entry))
  }
  return {
    assetStore,
    noteFile,
    describer,
    deviceReads,
    stored,
    run: () => {
      return service.reconcile({
        localOcrProviderId: 'vision',
        generation: GENERATION,
        mode: 'backfill',
      })
    },
  }
}

describe('local OCR', () => {
  it('refuses an unsupported cache platform before reading private attachment bytes', async () => {
    const { run, deviceReads, describer } = await setup({
      ocrSupport: { cache: false, pdf: false },
    })
    expect((await run()).stopped?.reason).toBe('unsupported')
    expect(deviceReads).toEqual([])
    expect(describer.calls()).toEqual([])
  })

  it('reads every PDF page with the verified local model and caches one complete device-only result', async () => {
    const { run, assetStore, describer, stored } = await setup()
    const readPage = vi.spyOn(assetStore, 'readPdfPageForDevice')

    const outcome = await run()

    expect(outcome.describedAssetPaths).toEqual(['assets/scan.pdf'])
    expect(readPage).toHaveBeenNthCalledWith(
      1,
      'assets/scan.pdf',
      1,
      GENERATION,
      expect.stringMatching(/^[a-f\d]{64}$/u),
    )
    expect(readPage).toHaveBeenNthCalledWith(
      2,
      'assets/scan.pdf',
      2,
      GENERATION,
      readPage.mock.calls[0]?.[3],
    )
    const request = describer.calls()[0]
    expect(request?.localModel?.target.kind).toBe('on-device')
    expect(request?.mediaType).toBe('image/png')
    const result = await stored('assets/scan.pdf')
    expect(result).toMatchObject({
      status: 'complete',
      deviceOnly: true,
      pages: 2,
      model: CONFIG.model,
    })
    expect(result?.body).toContain('## Page 2')
    expect(assetStore.ocrCache().size).toBe(1)
  })

  it('never caches a partially recognized PDF', async () => {
    const { run, describer, assetStore } = await setup()
    let pages = 0
    describer.setResult(() => {
      pages += 1
      if (pages === 2) {
        throw new Error('Model stopped')
      }
      return 'First page'
    })
    expect((await run()).stopped?.message).toBe('Model stopped')
    expect(assetStore.ocrCache().size).toBe(0)
  })

  it('refuses before reading private bytes when verification fails', async () => {
    const { run, deviceReads, describer } = await setup({ refused: 'Remote alias' })
    expect((await run()).stopped?.message).toBe('Remote alias')
    expect(deviceReads).toEqual([])
    expect(describer.calls()).toEqual([])
  })

  it('never falls back when the selected local model is unavailable or lacks vision', async () => {
    const { run, describer } = await setup({ provider: { ...CONFIG, supportsImages: false } })
    expect((await run()).stopped?.reason).toBe('config')
    expect(describer.calls()).toEqual([])
  })

  it('discards OCR when the source changed while the model was reading it', async () => {
    const { run, assetStore } = await setup()
    vi.spyOn(assetStore, 'readBytesForDevice')
      .mockResolvedValueOnce(new Uint8Array([1]))
      .mockResolvedValueOnce(new Uint8Array([2]))
    expect((await run()).skippedChanged).toBe(1)
    expect(assetStore.ocrCache().size).toBe(0)
  })

  it('preserves user-authored sidecars without reading the source', async () => {
    const { run, noteFile, deviceReads } = await setup()
    noteFile.set('assets/scan.pdf.reflect.md', 'User caption')
    expect((await run()).skippedUserAuthored).toBe(1)
    expect(deviceReads).toEqual([])
  })

  it('records the listed mtime so wake scans can skip re-hashing an untouched source', async () => {
    const { run, noteFile, stored } = await setup()
    noteFile.set('assets/scan.pdf', 'abc', { modifiedMs: 1234 })
    await run()
    expect((await stored('assets/scan.pdf'))?.sourceModifiedMs).toBe(1234)
  })

  describe('a failure confined to one attachment', () => {
    it('skips an oversize source and still recognizes the next attachment', async () => {
      const { run, assetStore } = await setup({ photo: true })
      vi.spyOn(assetStore, 'readBytesForDevice').mockImplementation((path) => {
        return Promise.try(() => {
          if (path === 'assets/scan.pdf') {
            throw new AppError('unsupported', 'source exceeds 20971520 bytes')
          }
          return new Uint8Array([9])
        })
      })
      const outcome = await run()
      expect(outcome.stopped).toBeNull()
      expect(outcome.skippedOversize).toBe(1)
      expect(outcome.describedAssetPaths).toEqual(['assets/photo.png'])
    })

    it('skips an offline source and a blank page instead of stopping the pass', async () => {
      const { run, assetStore, describer } = await setup({ photo: true })
      vi.spyOn(assetStore, 'readBytesForDevice').mockImplementation((path) => {
        return Promise.try(() => {
          if (path === 'assets/photo.png') {
            throw new AppError('io', 'the file is not available offline')
          }
          return new Uint8Array([1])
        })
      })
      describer.setResult('   ')
      const outcome = await run()
      expect(outcome.stopped).toBeNull()
      expect(outcome.refused).toBe(2)
      expect(assetStore.ocrCache().size).toBe(0)
    })

    it('skips PDFs where pages cannot render, without reading their bytes', async () => {
      const { run, assetStore, deviceReads } = await setup({
        photo: true,
        ocrSupport: { cache: true, pdf: false },
      })
      const pdfInfo = vi.spyOn(assetStore, 'pdfInfoForDevice')
      const outcome = await run()
      expect(outcome.stopped).toBeNull()
      expect(outcome.skippedOversize).toBe(1)
      expect(deviceReads).not.toContain('assets/scan.pdf')
      expect(pdfInfo).not.toHaveBeenCalled()
      expect(outcome.describedAssetPaths).toEqual(['assets/photo.png'])
    })

    it('skips the spelling of a link that names no file, never reading another file for it', async () => {
      // From `notes/`, `assets/photo.png` also reads as `notes/assets/photo.png`.
      const { run, deviceReads } = await setup({ photo: true, notePath: 'notes/private.md' })
      const outcome = await run()
      expect(outcome.stopped).toBeNull()
      expect(outcome.describedAssetPaths.sort()).toEqual(['assets/photo.png', 'assets/scan.pdf'])
      expect(outcome.skippedUnreferenced).toBe(2)
      expect(deviceReads).toEqual(
        expect.arrayContaining(['notes/assets/scan.pdf', 'notes/assets/photo.png']),
      )
    })

    it('still stops the whole pass when the local server is unavailable', async () => {
      const { run, describer } = await setup({ photo: true })
      describer.setResult(() => {
        throw new AppError('network', 'Server down')
      })
      const outcome = await run()
      expect(outcome.stopped).toMatchObject({ reason: 'network', message: 'Server down' })
      expect(describer.calls()).toHaveLength(1)
    })
  })
})
