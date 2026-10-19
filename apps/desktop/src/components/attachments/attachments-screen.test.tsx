import { createTestCoreServices } from '@reflect/core/testing'
import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import type { ReactElement } from 'react'
import type { AttachmentService, FileMeta } from '@reflect/core'
import { PeekProvider, usePeek } from '@/components/peek/peek-provider.tsx'
import { useRouter } from '@/routing/router.tsx'
import '@/test-utils/locator.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { resetRatioCaches } from './attachment-ratio-cache.ts'
import { AttachmentsScreen } from './attachments-screen.tsx'

/**
 * The Attachments screen over the real query layer and scripted services: the
 * file listing from `attachments.listFiles`, "linked from" notes and their
 * tags from the note list, and navigation through the real router.
 */

// Every asset URL serves one real 1×1 PNG, so thumbnails load (and report
// their size) instead of falling back — except paths listed in `broken`,
// which serve bytes no image decoder accepts. The asset path rides in the
// fragment.
const assets = (() => {
  const bytes = Uint8Array.from(
    atob(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
    ),
    (character) => character.charCodeAt(0),
  )
  return {
    image: URL.createObjectURL(new Blob([bytes], { type: 'image/png' })),
    corrupt: URL.createObjectURL(new Blob(['not an image'], { type: 'image/png' })),
    broken: new Set<string>(),
  }
})()

const DAY = 24 * 60 * 60 * 1000
const files: FileMeta[] = [
  { path: 'assets/table.csv', size: 10, modifiedMs: 6 * DAY },
  { path: 'assets/clip.mp4', size: 10, modifiedMs: 5 * DAY },
  { path: 'assets/photo.png', size: 10, modifiedMs: 4 * DAY },
  { path: 'assets/report.pdf', size: 10, modifiedMs: 3 * DAY },
  { path: 'assets/logo.svg', size: 10, modifiedMs: 2 * DAY },
  { path: 'assets/stray.jpg', size: 10, modifiedMs: 1 * DAY },
]
const references = [
  {
    isPrivate: false,
    assetPath: 'assets/photo.png',
    notePath: 'notes/trip.md',
    title: 'Trip',
    mtime: 9,
  },
  {
    isPrivate: false,
    assetPath: 'photo.png',
    notePath: 'notes/later.md',
    title: 'Later',
    mtime: 10,
  },
  {
    isPrivate: false,
    assetPath: 'assets/report.pdf',
    notePath: 'notes/report.md',
    title: 'Report',
    mtime: 3,
  },
]
const noteTags = [
  { notePath: 'notes/trip.md', tag: 'travel' },
  { notePath: 'notes/report.md', tag: 'Travel' },
  { notePath: 'notes/report.md', tag: 'work' },
]

/** What the file listing reports; tests swap it, then refetch. */
let listing: readonly FileMeta[] = files
let openOrReveal: MockInstance<AttachmentService['openOrReveal']>

function serve(next: readonly FileMeta[]): void {
  listing = next
}

beforeEach(() => {
  // Media sizes remembered by an earlier test must not shape this one's layout.
  resetRatioCaches()
  localStorage.removeItem('reflect.attachment-ratios:/g')
  assets.broken.clear()
  serve(files)
})

function PeekProbe(): ReactElement {
  const peek = usePeek()
  return <output data-testid="peek">{JSON.stringify(peek?.target ?? null)}</output>
}

function RoutedScreen(): ReactElement {
  const { route } = useRouter()
  return route.kind === 'attachments' ? (
    <AttachmentsScreen type={route.type} tag={route.tag} />
  ) : (
    <AttachmentsScreen type={null} tag={null} />
  )
}

async function renderScreen() {
  const app = createTestCoreServices()
  vi.spyOn(app.attachments, 'listFiles').mockImplementation(() => Promise.resolve([...listing]))
  vi.spyOn(app.attachments, 'assetUrl').mockImplementation(
    (path, generation) =>
      `${assets.broken.has(`${generation}/${path}`) ? assets.corrupt : assets.image}#reflect-asset/${generation}/${path}`,
  )
  openOrReveal = vi.spyOn(app.attachments, 'openOrReveal').mockResolvedValue(undefined)
  vi.spyOn(app.noteList, 'listAttachmentReferences').mockResolvedValue(references)
  vi.spyOn(app.noteList, 'listAttachmentNoteTags').mockResolvedValue(noteTags)
  return await renderInApp(
    <PeekProvider>
      {/* A fixed width gives the flow three columns. */}
      <div style={{ height: '100vh', width: 900 }}>
        <RoutedScreen />
      </div>
      <PeekProbe />
    </PeekProvider>,
    {
      app,
      graph: { root: '/g', name: 'g', generation: 7 },
      route: { kind: 'attachments', type: null, tag: null },
      settings: { dateFormat: 'iso', timeFormat: '24h' },
    },
  )
}

type ScreenView = Awaited<ReturnType<typeof renderScreen>>

function probedRoute(view: ScreenView): unknown {
  return view.appServices.navigation.getState().route
}

/** The card preview buttons, in DOM (reading) order. */
function cardLabels(): (string | null)[] {
  return [...document.querySelectorAll('[data-attachment-index]')].map((card) =>
    card.getAttribute('aria-label'),
  )
}

/** The element holding focus, if any. */
function focusedElement(): Element | null {
  return document.activeElement
}

describe('AttachmentsScreen', () => {
  it('lists media files newest first, each with the notes linking to it', async () => {
    await renderScreen()

    await expect.element(page.getByRole('heading', { name: 'Attachments' })).toBeVisible()
    await expect.element(page.getByTestId('attachments-count')).toHaveTextContent('5')
    // Cards mount once the flow has measured its viewport.
    await expect
      .poll(cardLabels)
      .toEqual([
        'Open clip.mp4',
        'Preview photo.png',
        'Preview report.pdf',
        'Preview logo.svg',
        'Preview stray.jpg',
      ])

    const photo = page.getByRole('listitem').filter({ hasText: 'photo.png' })
    // The most recently edited linking note leads; the other is counted.
    await expect.element(photo.getByRole('button', { name: 'Later' })).toBeVisible()
    await expect.element(photo.getByText('+1')).toBeVisible()
    await expect
      .element(
        page.getByRole('listitem').filter({ hasText: 'stray.jpg' }).getByText('No links found'),
      )
      .toBeVisible()

    const thumbnails = [...document.querySelectorAll('[data-attachment-index] img')].map((image) =>
      image.getAttribute('src'),
    )
    expect(thumbnails).toEqual([
      expect.stringMatching(
        /#reflect-asset\/7\/assets\/photo\.png\?reflect-preview=thumb&width=(320|640|960|1280)&v=\d+-10$/,
      ),
      expect.stringMatching(
        /#reflect-asset\/7\/assets\/report\.pdf\?reflect-preview=pdf-page&page=1&width=\d+&v=\d+-10$/,
      ),
      expect.stringMatching(
        /#reflect-asset\/7\/assets\/stray\.jpg\?reflect-preview=thumb&width=(320|640|960|1280)&v=\d+-10$/,
      ),
    ])
  })

  it('offers a tab per type the graph has and narrows the flow to it', async () => {
    const view = await renderScreen()
    const filters = page.getByRole('group', { name: 'Filter attachments' })
    await expect.element(filters.getByRole('button', { name: 'PDF' })).toBeVisible()
    expect(filters.getByRole('button', { name: 'Audio' }).query()).toBeNull()

    await filters.getByRole('button', { name: 'PDF' }).click()

    await expect
      .poll(() => probedRoute(view))
      .toEqual({ kind: 'attachments', type: 'pdf', tag: null })
    await expect.element(page.getByTestId('attachments-count')).toHaveTextContent('1')
    await expect.poll(cardLabels).toEqual(['Preview report.pdf'])
  })

  it('narrows to files linked from notes with a tag, combined with the type', async () => {
    const view = await renderScreen()
    const tagFilter = page.getByRole('group', { name: 'Filter attachments by tag' })
    await tagFilter.getByRole('button', { name: 'Tag' }).click()
    // Facets fold casing and count files: photo (via Trip) and report.
    await expect.element(page.getByRole('option', { name: '#travel 2' })).toBeVisible()
    await page.getByRole('option', { name: '#work 1' }).click()

    await expect
      .poll(() => probedRoute(view))
      .toEqual({ kind: 'attachments', type: null, tag: 'work' })
    await expect.poll(cardLabels).toEqual(['Preview report.pdf'])

    // The type tabs keep the tag; the clear button drops it and keeps the type.
    await page
      .getByRole('group', { name: 'Filter attachments' })
      .getByRole('button', { name: 'Images' })
      .click()
    await expect.element(page.getByText('No images in notes tagged #work.')).toBeVisible()
    await tagFilter.getByRole('button', { name: 'Clear tag filter' }).click()
    await expect
      .poll(() => probedRoute(view))
      .toEqual({ kind: 'attachments', type: 'image', tag: null })
    await expect
      .poll(cardLabels)
      .toEqual(['Preview photo.png', 'Preview logo.svg', 'Preview stray.jpg'])
  })

  it('opens the linking note', async () => {
    const view = await renderScreen()

    await page.getByRole('button', { name: 'Later' }).click()

    await expect.poll(() => probedRoute(view)).toEqual({ kind: 'note', path: 'notes/later.md' })
  })

  it('lists every linking note from the "+N" menu, from the keyboard too', async () => {
    const view = await renderScreen()
    const more = page.getByRole('button', { name: '1 more note links to photo.png' })
    await expect.element(more).toBeVisible()

    const trigger = more.element()
    if (trigger instanceof HTMLElement) {
      trigger.focus()
    }
    await userEvent.keyboard('{Enter}')
    const menu = page.getByRole('menu', { name: '1 more note links to photo.png' })
    await expect.element(menu.getByRole('menuitem', { name: 'Later' })).toBeVisible()
    await expect.element(menu.getByRole('menuitem', { name: 'Trip' })).toBeVisible()

    await menu.getByRole('menuitem', { name: 'Trip' }).click()
    await expect.poll(() => probedRoute(view)).toEqual({ kind: 'note', path: 'notes/trip.md' })
  })

  it('previews images in the lightbox, PDFs in Peek, and opens video in its default app', async () => {
    await renderScreen()

    await page.getByRole('button', { name: 'Open clip.mp4' }).click()
    expect(openOrReveal).toHaveBeenCalledWith('assets/clip.mp4')

    await page.getByRole('button', { name: 'Preview report.pdf' }).click()
    await expect
      .element(page.getByTestId('peek'))
      .toHaveTextContent(JSON.stringify({ kind: 'pdf', path: 'assets/report.pdf' }))

    await page.getByRole('button', { name: 'Preview logo.svg' }).click()
    await expect.element(page.getByRole('button', { name: 'Close image preview' })).toBeVisible()
    await page.getByRole('button', { name: 'Open', exact: true }).click()
    expect(openOrReveal).toHaveBeenLastCalledWith('assets/logo.svg')
  })

  it('moves between cards with the arrow keys, starting from the screen', async () => {
    await renderScreen()
    await expect.element(page.getByRole('button', { name: 'Open clip.mp4' })).toBeVisible()

    // Three columns: clip, photo, report across the top; logo under clip;
    // stray under photo.
    await userEvent.keyboard('{ArrowRight}')
    expect(focusedElement()?.getAttribute('aria-label')).toBe('Open clip.mp4')
    await userEvent.keyboard('{ArrowDown}')
    expect(focusedElement()?.getAttribute('aria-label')).toBe('Preview logo.svg')
    await userEvent.keyboard('{ArrowRight}')
    expect(focusedElement()?.getAttribute('aria-label')).toBe('Preview stray.jpg')
    await userEvent.keyboard('{ArrowUp}')
    expect(focusedElement()?.getAttribute('aria-label')).toBe('Preview photo.png')
  })

  it('mounts only the cards near the viewport, and more as it scrolls', async () => {
    serve(
      Array.from({ length: 600 }, (_, index) => ({
        path: `assets/f${String(index).padStart(3, '0')}.png`,
        size: 10,
        modifiedMs: 600 - index,
      })),
    )
    await renderScreen()
    await expect.element(page.getByRole('button', { name: 'Preview f000.png' })).toBeVisible()

    const mountedCount = (): number => cardLabels().length
    expect(mountedCount()).toBeGreaterThan(0)
    expect(mountedCount()).toBeLessThan(200)
    expect(page.getByRole('button', { name: 'Preview f599.png' }).query()).toBeNull()

    const scroller = page.getByTestId('attachments-scroll').element()
    scroller.scrollTop = scroller.scrollHeight
    await expect.element(page.getByRole('button', { name: 'Preview f599.png' })).toBeInTheDocument()
    expect(page.getByRole('button', { name: 'Preview f000.png' }).query()).toBeNull()
  })

  it('keeps keyboard focus on its card when a newer file sorts in ahead of it', async () => {
    const many = Array.from({ length: 600 }, (_, index) => ({
      path: `assets/f${String(index).padStart(3, '0')}.png`,
      size: 10,
      modifiedMs: 600 - index,
    }))
    serve(many)
    const view = await renderScreen()
    await expect.element(page.getByRole('button', { name: 'Preview f000.png' })).toBeVisible()
    await userEvent.keyboard('{ArrowRight}')
    expect(focusedElement()?.getAttribute('aria-label')).toBe('Preview f000.png')

    // Scroll far past the focused card: it stays mounted, and focused.
    const scroller = page.getByTestId('attachments-scroll').element()
    scroller.scrollTop = scroller.scrollHeight
    await expect.element(page.getByRole('button', { name: 'Preview f599.png' })).toBeInTheDocument()

    // A new file lands at the top, shifting every card's position by one.
    serve([{ path: 'assets/newest.png', size: 10, modifiedMs: 10_000 }, ...many])
    await view.queryClient.invalidateQueries()
    await expect.element(page.getByTestId('attachments-count')).toHaveTextContent('601')
    expect(focusedElement()?.getAttribute('aria-label')).toBe('Preview f000.png')
  })

  it('keeps keyboard focus on a card whose file is rewritten', async () => {
    const view = await renderScreen()
    await expect.element(page.getByRole('button', { name: 'Open clip.mp4' })).toBeVisible()
    // Into the flow at clip.mp4 (column 0), then across to photo.png (column 1).
    await userEvent.keyboard('{ArrowRight}')
    await userEvent.keyboard('{ArrowRight}')
    expect(focusedElement()?.getAttribute('aria-label')).toBe('Preview photo.png')
    const focused = document.activeElement

    serve(
      files.map((file) =>
        file.path === 'assets/photo.png' ? { ...file, modifiedMs: file.modifiedMs + 1 } : file,
      ),
    )
    await view.queryClient.invalidateQueries()
    await vi.waitFor(() =>
      expect(focused?.querySelector('img')?.getAttribute('src')).toContain(`&v=${4 * DAY + 1}-10`),
    )
    expect(document.activeElement).toBe(focused)
  })

  it('hands focus back to an off-screen card when the preview it opened closes', async () => {
    serve(
      Array.from({ length: 600 }, (_, index) => ({
        path: `assets/f${String(index).padStart(3, '0')}.png`,
        size: 10,
        modifiedMs: 600 - index,
      })),
    )
    await renderScreen()
    await expect.element(page.getByRole('button', { name: 'Preview f000.png' })).toBeVisible()
    await userEvent.keyboard('{ArrowRight}')
    const card = document.activeElement
    expect(card?.getAttribute('aria-label')).toBe('Preview f000.png')
    const scroller = page.getByTestId('attachments-scroll').element()
    scroller.scrollTop = scroller.scrollHeight
    await expect.element(page.getByRole('button', { name: 'Preview f599.png' })).toBeInTheDocument()

    await userEvent.keyboard('{Enter}')
    await expect.element(page.getByRole('button', { name: 'Close image preview' })).toBeVisible()
    await userEvent.keyboard('{Escape}')

    await expect
      .element(page.getByRole('button', { name: 'Close image preview' }))
      .not.toBeInTheDocument()
    await vi.waitFor(() => expect(document.activeElement).toBe(card))
  })

  it('keeps a card mounted while its footer link holds focus, scrolled away', async () => {
    // photo.png (linked from "Later") leads; f000 sits beside it.
    serve([
      { path: 'assets/photo.png', size: 10, modifiedMs: 1_000 },
      ...Array.from({ length: 600 }, (_, index) => ({
        path: `assets/f${String(index).padStart(3, '0')}.png`,
        size: 10,
        modifiedMs: 600 - index,
      })),
    ])
    await renderScreen()
    await expect.element(page.getByRole('button', { name: 'Later' })).toBeVisible()
    await userEvent.keyboard('{ArrowRight}')
    await userEvent.keyboard('{ArrowRight}')
    expect(focusedElement()?.getAttribute('aria-label')).toBe('Preview f000.png')
    // Focus moves from f000's preview into photo.png's note link (Shift-Tab
    // does this in Chromium; WebKit's tab order is platform-configured).
    const link = page.getByRole('button', { name: 'Later' }).element()
    link.focus({ preventScroll: true })
    expect(document.activeElement).toBe(link)

    const scroller = page.getByTestId('attachments-scroll').element()
    scroller.scrollTop = scroller.scrollHeight
    await expect.element(page.getByRole('button', { name: 'Preview f599.png' })).toBeInTheDocument()
    expect(link.isConnected).toBe(true)
    expect(document.activeElement).toBe(link)
  })

  it('reloads a card whose file was rewritten, clearing an earlier load failure', async () => {
    assets.broken.add('7/assets/photo.png')
    const view = await renderScreen()
    // Thumbnail and raster fallback both fail, so the card opens the file instead.
    await expect.element(page.getByRole('button', { name: 'Open photo.png' })).toBeInTheDocument()

    assets.broken.clear()
    serve(
      files.map((file) =>
        file.path === 'assets/photo.png' ? { ...file, modifiedMs: file.modifiedMs + 1 } : file,
      ),
    )
    await view.queryClient.invalidateQueries()

    const photo = page.getByRole('button', { name: 'Preview photo.png' })
    await expect.element(photo).toBeInTheDocument()
    expect(photo.element().querySelector('img')?.getAttribute('src')).toContain(
      `&v=${4 * DAY + 1}-10`,
    )
  })

  it('says when the graph has no media', async () => {
    serve([{ path: 'assets/table.csv', size: 10, modifiedMs: 1 }])
    await renderScreen()

    await expect.element(page.getByText(/^No attachments yet\./)).toBeVisible()
  })
})
