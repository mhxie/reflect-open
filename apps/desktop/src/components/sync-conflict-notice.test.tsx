import { render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getNote, readNote, type GraphInfo } from '@reflect/core'
import { setPlatformSurface } from '@/lib/platform-surface.ts'
import { SyncConflictNotice } from './sync-conflict-notice.tsx'

vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  getNote: vi.fn(),
  readNote: vi.fn(),
}))

const graphState = vi.hoisted(() => ({
  graph: { root: '/g', name: 'G', generation: 3 } as GraphInfo | null,
  indexGeneration: 7 as number | null,
}))
vi.mock('@/providers/graph-provider.tsx', () => ({ useGraph: () => graphState }))

const resolution = vi.hoisted(() => ({
  busy: false,
  error: null as string | null,
  resolve: vi.fn(async () => {}),
}))
const useConflictResolution = vi.hoisted(() =>
  vi.fn((_path: string, _shownContent?: string) => resolution),
)
vi.mock('@/hooks/use-conflict-resolution.ts', () => ({ useConflictResolution }))

const NOTE = {
  path: 'notes/clash.md',
  title: 'Clash',
  dailyDate: null,
  isPrivate: false,
  hasConflict: true,
  gistUrl: null,
  gistStale: false,
}

let queryClient: QueryClient

beforeEach(() => {
  resolution.error = null
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
})

afterEach(() => {
  queryClient.clear()
  setPlatformSurface({ mobileApp: false })
  vi.clearAllMocks()
})

async function renderNotice(props: { shownContent?: string } = {}): Promise<void> {
  await render(
    <QueryClientProvider client={queryClient}>
      <SyncConflictNotice path="notes/clash.md" {...props} />
    </QueryClientProvider>,
  )
}

describe('SyncConflictNotice', () => {
  it('renders nothing for a note without conflict markers', async () => {
    vi.mocked(getNote).mockResolvedValue({ ...NOTE, hasConflict: false })
    await renderNotice()

    await vi.waitFor(() => expect(getNote).toHaveBeenCalled()) // let the query settle
    expect(page.getByText(/edited on two devices/i).query()).toBeNull()
  })

  it('offers mine/theirs/both resolutions for a conflicted note', async () => {
    vi.mocked(getNote).mockResolvedValue(NOTE)
    await renderNotice()

    await expect.element(page.getByText(/edited on two devices/i)).toBeInTheDocument()

    await page.getByRole('button', { name: /keep this device’s version/i }).click()
    expect(resolution.resolve).toHaveBeenCalledWith('ours')

    await page.getByRole('button', { name: /keep the other device’s/i }).click()
    expect(resolution.resolve).toHaveBeenCalledWith('theirs')

    await page.getByRole('button', { name: /keep both/i }).click()
    expect(resolution.resolve).toHaveBeenCalledWith('both')
    // No conflict view beside it: resolution reads the file at click.
    expect(useConflictResolution).toHaveBeenCalledWith('notes/clash.md', undefined)
  })

  it('resolves exactly the text the conflict view shows', async () => {
    vi.mocked(getNote).mockResolvedValue(NOTE)
    const shown = '<<<<<<< this device\nmine\n=======\ntheirs\n>>>>>>> other device\n'
    await renderNotice({ shownContent: shown })
    await expect.element(page.getByText(/edited on two devices/i)).toBeInTheDocument()

    expect(useConflictResolution).toHaveBeenCalledWith('notes/clash.md', shown)
    expect(useConflictResolution).not.toHaveBeenCalledWith('notes/clash.md', undefined)
  })

  it('offers the same resolution actions on mobile', async () => {
    setPlatformSurface({ mobileApp: true })
    vi.mocked(getNote).mockResolvedValue(NOTE)
    await renderNotice()

    await expect.element(page.getByText(/choose what to keep/i)).toBeInTheDocument()

    await page.getByRole('button', { name: /keep this device’s version/i }).click()
    expect(resolution.resolve).toHaveBeenCalledWith('ours')
  })

  it('pluralizes the buttons for a stacked three-plus-way conflict', async () => {
    vi.mocked(getNote).mockResolvedValue(NOTE)
    vi.mocked(readNote).mockResolvedValue(
      '<<<<<<< Mac\nmac\n=======\nphone\n>>>>>>> iPhone\n<<<<<<< Mac\n=======\nipad\n>>>>>>> iPad\n',
    )
    await renderNotice()

    // `theirs` splices in every non-first side — naming one device would lie.
    await expect
      .element(page.getByRole('button', { name: 'Keep the other versions' }))
      .toBeInTheDocument()
    await expect.element(page.getByRole('button', { name: 'Keep all' })).toBeInTheDocument()
    // The first side is still a single device, so it stays named.
    await expect.element(page.getByRole('button', { name: 'Keep “Mac”' })).toBeInTheDocument()
  })
})
