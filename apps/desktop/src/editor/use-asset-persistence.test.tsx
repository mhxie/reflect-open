import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ReflectError,
  LARGE_FILE_BYTES,
  createAttachmentService,
  createLocalOnlyFolders,
  type AttachmentService,
} from '@reflect/core'
import {
  createTestCoreServices,
  createTestAssetStoreService,
  createTestAttachmentService,
  createTestClockService,
  createTestFileChangeService,
  createTestNoteFileService,
  createTestProgressPort,
  createTestPlatformService,
  type TestAttachmentService,
  type TestAttachmentServiceOptions,
} from '@reflect/core/testing'
import { renderHookInApp } from '@/test-utils/render-in-app.tsx'
import { useAssetPersistence, type AssetPersistence } from './use-asset-persistence.ts'

let persistence: AssetPersistence | null = null
// The app of the latest `renderPersistence`; the attachment services read its graph.
let app: ReturnType<typeof createTestCoreServices<{ attachments: AttachmentService }>>
const graphSession = { getState: () => app.graphSession.getState() }
// The attachment service of the next `renderPersistence`.
let attachmentService: AttachmentService = createTestAttachmentService({ graphSession })

/**
 * The local-only folder of the graph `renderPersistence({ localOnly: true })` opens; editable in place.
 */
const SECURE = 'secure'

function renderPersistence({
  generation,
  path = 'notes/a.md',
  localOnly = false,
}: {
  generation: number | null
  path?: string
  localOnly?: boolean
}) {
  app = createTestCoreServices({ attachments: attachmentService })
  return renderHookInApp(
    ({ path }: { path: string } = { path: 'notes/a.md' }) => {
      persistence = useAssetPersistence(path)
    },
    {
      initialProps: { path },
      app,
      graph:
        generation === null
          ? null
          : localOnly
            ? { generation, localOnlyFolders: [SECURE], localOnlyEditableFolders: [SECURE] }
            : { generation },
    },
  )
}

function installAttachments(options?: TestAttachmentServiceOptions): TestAttachmentService {
  const attachments = createTestAttachmentService({ ...options, graphSession })
  attachmentService = attachments
  return attachments
}

function fileOf(name: string, type: string, size = 16): File {
  const file = new File([new Uint8Array(Math.min(size, 64))], name, { type })
  Object.defineProperty(file, 'size', { value: size })
  return file
}

/**
 * The real attachment service over an asset store that picks the attachment
 * folder the way Rust does (an editable local-only note's own `assets/`),
 * with the note every upload named and the status-line reports.
 */
function installRoutingAttachments() {
  const assetStore = createTestAssetStoreService({
    localOnly: createLocalOnlyFolders([SECURE], [SECURE]),
  })
  const uploadBlob = vi.spyOn(assetStore, 'uploadBlob')
  const progress = createTestProgressPort()
  attachmentService = createAttachmentService({
    assetStore,
    noteFile: createTestNoteFileService(),
    fileChanges: createTestFileChangeService(),
    progress,
    clock: createTestClockService({ now: 1_700_000_000_000 }),
    platform: createTestPlatformService(),
    graphSession,
  })
  return {
    progress,
    uploadedFor: () => uploadBlob.mock.calls.map(([, , notePath]) => notePath),
  }
}

afterEach(() => {
  attachmentService = createTestAttachmentService({ graphSession })
  persistence = null
})

describe('useAssetPersistence', () => {
  it('resolves against the note it renders and its graph session', async () => {
    installAttachments({ catalog: [{ path: 'attachments/report.pdf', size: 42 }] })
    await renderPersistence({ generation: 3, path: 'Projects/Plan.md' })

    expect(persistence!.resolveImageUrl('../attachments/garden.png')).toBe(
      `reflect-asset://localhost/${encodeURIComponent('3/attachments/garden.png')}`,
    )
    expect(persistence!.resolveAssetOpenPath('../attachments/report.pdf')).toBe(
      'attachments/report.pdf',
    )
    expect(
      persistence!.resolveFileLink({ href: '../attachments/report.pdf', label: '', title: '' }),
    ).toBe(true)
    await expect(persistence!.resolveFileInfo('../attachments/report.pdf')).resolves.toEqual({
      size: 42,
    })
    expect(
      persistence!.resolveWikiEmbed({
        target: 'Deep Work',
        display: '',
        width: null,
        height: null,
      }),
    ).toEqual({ kind: 'note' })
  })

  it('opens attachments in the graph session', async () => {
    const attachments = installAttachments()
    const { act } = await renderPersistence({ generation: 3 })

    await act(async () => {
      await persistence!.openAsset('assets/q3-report.pdf')
    })

    expect(attachments.opened()).toEqual(['assets/q3-report.pdf'])
  })

  it('declines without a graph session', async () => {
    const attachments = installAttachments()
    const { act } = await renderPersistence({ generation: null })

    let saved: string | null = 'sentinel'
    await act(async () => {
      saved = await persistence!.saveFile(fileOf('a.pdf', 'application/pdf'))
      await persistence!.openAsset('assets/q3-report.pdf')
    })

    expect(saved).toBeNull()
    expect(attachments.saves()).toEqual([])
    expect(attachments.opened()).toEqual([])
    expect(persistence!.resolveImageUrl('assets/cat.png')).toBeUndefined()
    expect(persistence!.resolveAssetOpenPath('assets/cat.png')).toBeNull()
    await expect(persistence!.resolveFileInfo('assets/cat.png')).resolves.toBeUndefined()
  })

  it('shows the latest failed save until the next success', async () => {
    const attachments = installAttachments()
    const { act } = await renderPersistence({ generation: 3 })

    attachments.failSaves({ kind: 'image', message: 'disk full' })
    await act(async () => {
      await expect(persistence!.saveFile(fileOf('a.png', 'image/png'))).resolves.toBeNull()
    })
    expect(persistence!.saveError).toEqual({ kind: 'image', message: 'disk full' })

    attachments.failSaves(null)
    await act(async () => {
      await expect(persistence!.saveFile(fileOf('b.pdf', 'application/pdf'))).resolves.toBe(
        'assets/b.pdf',
      )
    })
    expect(persistence!.saveError).toBeNull()
    expect(attachments.saves()).toMatchObject([{ name: 'b.pdf', generation: 3 }])
  })

  it('drops a failure that lands after the note switched', async () => {
    const upload = Promise.withResolvers<string>()
    const clock = createTestClockService()
    attachmentService = createAttachmentService({
      assetStore: Object.assign(createTestAssetStoreService(), {
        uploadBlob: () => upload.promise,
      }),
      noteFile: createTestNoteFileService(),
      fileChanges: createTestFileChangeService(),
      progress: createTestProgressPort(),
      clock,
      platform: createTestPlatformService(),
      graphSession,
    })
    const view = await renderPersistence({ generation: 3, path: 'notes/a.md' })

    let savePromise: Promise<string | null> | null = null
    await view.act(() => {
      savePromise = persistence!.saveFile(fileOf('slow.pdf', 'application/pdf'))
    })

    // The user moves on; the save then fails for the note they left.
    await view.rerender({ path: 'notes/b.md' })
    await view.act(async () => {
      upload.reject(new ReflectError('io', 'late failure'))
      await savePromise
    })

    await expect(savePromise).resolves.toBeNull()
    expect(persistence!.saveError).toBeNull()
  })
})

describe('useAssetPersistence saveFile for local-only notes', () => {
  it('names the note, links its folder’s copy vault-root-absolute, and warns about no Git limit', async () => {
    const { progress, uploadedFor } = installRoutingAttachments()
    const { act } = await renderPersistence({
      generation: 3,
      path: 'My Finance/secure/bank.md',
      localOnly: true,
    })

    let saved: string | null = null
    await act(async () => {
      saved = await persistence!.saveFile(
        fileOf('Huge Scan.mov', 'video/quicktime', LARGE_FILE_BYTES + 1),
      )
    })

    expect(uploadedFor()).toEqual(['My Finance/secure/bank.md'])
    expect(saved).toBe('/My%20Finance/secure/assets/huge-scan.mov')
    // It never enters the Git backup, so the backup's size limits don't apply.
    expect(progress.getAll().filter((operation) => operation.status === 'warning')).toEqual([])
    // The pill sizes it from the save itself, by the link it inserted.
    await expect(persistence!.resolveFileInfo(saved!)).resolves.toEqual({
      size: LARGE_FILE_BYTES + 1,
    })
  })

  it('sends the note the pane shows when the save starts, after the pane switched notes', async () => {
    const { uploadedFor } = installRoutingAttachments()
    const view = await renderPersistence({ generation: 3, path: 'notes/plan.md', localOnly: true })

    let saved: string | null = null
    await view.act(async () => {
      saved = await persistence!.saveFile(fileOf('a.png', 'image/png'))
    })
    expect(saved).toMatch(/^assets\/pasted-\d+\.png$/)

    // The same pane now shows an editable local-only note.
    await view.rerender({ path: 'My Finance/secure/bank.md' })
    await view.act(async () => {
      saved = await persistence!.saveFile(fileOf('b.png', 'image/png'))
    })

    expect(uploadedFor()).toEqual(['notes/plan.md', 'My Finance/secure/bank.md'])
    expect(saved).toMatch(/^\/My%20Finance\/secure\/assets\/pasted-\d+\.png$/)
  })
})

describe('useAssetPersistence resolveAssetOpenPath', () => {
  it("opens a linked page from the note's own folder, and never renders it", async () => {
    installRoutingAttachments()
    await renderPersistence({ generation: 3, path: 'career/Hunt/Explainers.md' })

    expect(persistence!.resolveAssetOpenPath('assets/q07.html')).toBe('career/Hunt/assets/q07.html')
    // A page is opened, never rendered: no in-app URL for it.
    expect(await persistence!.resolveImageUrl('assets/q07.html')).toBeUndefined()
  })
})
