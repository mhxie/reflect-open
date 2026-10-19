import { page } from 'vitest/browser'
import { describe, expect, it, vi, type MockInstance } from 'vitest'
import type { ConflictResolutionService, IndexQueryService, NoteFileService } from '@reflect/core'
import { createTestCoreServices, createTestPlatformService } from '@reflect/core/testing'
import { MOBILE_PLATFORM, renderInApp } from '@/test-utils/render-in-app.tsx'
import { SyncConflictNotice } from './sync-conflict-notice.tsx'

const NOTE = {
  path: 'notes/clash.md',
  title: 'Clash',
  dailyDate: null,
  isPrivate: false,
  hasConflict: true,
  gistUrl: null,
  gistStale: false,
}

const SESSION = { generation: 3, indexGeneration: 7 }

// The spies of the rendered app; set by `renderNotice`.
let getNote: MockInstance<IndexQueryService['getNote']>
let resolve: MockInstance<ConflictResolutionService['resolve']>

async function renderNotice(options?: {
  note?: typeof NOTE
  source?: string
  mobile?: boolean
}): Promise<void> {
  const app = createTestCoreServices({
    platform: createTestPlatformService(options?.mobile ? MOBILE_PLATFORM : {}),
  })
  getNote = vi.spyOn(app.indexQuery, 'getNote').mockResolvedValue(options?.note ?? NOTE)
  const source = options?.source
  if (source !== undefined) {
    const read: NoteFileService['read'] = async () => source
    vi.spyOn(app.noteFile, 'read').mockImplementation(read)
  }
  resolve = vi
    .spyOn(app.conflictResolution, 'resolve')
    .mockResolvedValue({ wrote: false, error: null })
  await renderInApp(<SyncConflictNotice path="notes/clash.md" />, {
    app,
    graph: { root: '/g', name: 'G', ...SESSION },
  })
}

describe('SyncConflictNotice', () => {
  it('renders nothing for a note without conflict markers', async () => {
    await renderNotice({ note: { ...NOTE, hasConflict: false } })

    await vi.waitFor(() => expect(getNote).toHaveBeenCalled()) // let the query settle
    expect(page.getByText(/edited on two devices/i).query()).toBeNull()
  })

  it('offers mine/theirs/both resolutions for a conflicted note', async () => {
    await renderNotice()

    await expect.element(page.getByText(/edited on two devices/i)).toBeInTheDocument()

    await page.getByRole('button', { name: /keep this device’s version/i }).click()
    expect(resolve).toHaveBeenCalledWith('notes/clash.md', 'ours')

    await page.getByRole('button', { name: /keep the other device’s/i }).click()
    expect(resolve).toHaveBeenCalledWith('notes/clash.md', 'theirs')

    await page.getByRole('button', { name: /keep both/i }).click()
    expect(resolve).toHaveBeenCalledWith('notes/clash.md', 'both')
  })

  it('offers the same resolution actions on mobile', async () => {
    await renderNotice({ mobile: true })

    await expect.element(page.getByText(/choose what to keep/i)).toBeInTheDocument()

    await page.getByRole('button', { name: /keep this device’s version/i }).click()
    expect(resolve).toHaveBeenCalledWith('notes/clash.md', 'ours')
  })

  it('pluralizes the buttons for a stacked three-plus-way conflict', async () => {
    await renderNotice({
      source:
        '<<<<<<< Mac\nmac\n=======\nphone\n>>>>>>> iPhone\n<<<<<<< Mac\n=======\nipad\n>>>>>>> iPad\n',
    })

    // `theirs` splices in every non-first side — naming one device would lie.
    await expect
      .element(page.getByRole('button', { name: 'Keep the other versions' }))
      .toBeInTheDocument()
    await expect.element(page.getByRole('button', { name: 'Keep all' })).toBeInTheDocument()
    // The first side is still a single device, so it stays named.
    await expect.element(page.getByRole('button', { name: 'Keep “Mac”' })).toBeInTheDocument()
  })
})
