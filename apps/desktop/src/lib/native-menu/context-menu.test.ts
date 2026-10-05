import { beforeEach, describe, expect, it, vi } from 'vitest'

const isTauri = vi.hoisted(() => vi.fn(() => true))
const popup = vi.hoisted(() => vi.fn(async () => {}))
interface NativeMenuItemForTest {
  text: string
  action?: () => void
}

interface NativeMenuOptionsForTest {
  items?: NativeMenuItemForTest[]
}

interface NativeMenuForTest {
  popup: () => Promise<void>
}

const menuNew = vi.hoisted(() =>
  vi.fn(async (_options?: NativeMenuOptionsForTest): Promise<NativeMenuForTest> => ({
    popup,
  })),
)

vi.mock('@tauri-apps/api/core', () => ({ isTauri }))
const menuItemNew = vi.hoisted(() => vi.fn(async (options: NativeMenuItemForTest) => options))
const predefinedNew = vi.hoisted(() => vi.fn(async (options: { item: string }) => options))

vi.mock('@tauri-apps/api/menu', () => ({
  Menu: { new: menuNew },
  MenuItem: { new: menuItemNew },
  PredefinedMenuItem: { new: predefinedNew },
}))

const { NATIVE_MENU_SEPARATOR, openNativeContextMenu } = await import('./context-menu.ts')

beforeEach(() => {
  isTauri.mockReset().mockReturnValue(true)
  popup.mockClear()
  menuItemNew.mockClear()
  predefinedNew.mockClear()
  menuNew.mockResolvedValue({ popup })
})

function firstMenuItem(): NativeMenuItemForTest {
  const item = menuNew.mock.calls[0]?.[0]?.items?.[0]
  if (item === undefined) {
    throw new Error('expected native menu item')
  }
  return item
}

describe('openNativeContextMenu', () => {
  it('does nothing outside Tauri', async () => {
    isTauri.mockReturnValue(false)
    const onSelect = vi.fn()

    await openNativeContextMenu({ items: [{ text: 'Unpin Note', action: onSelect }] })

    expect(menuNew).not.toHaveBeenCalled()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('opens a native menu whose items run their actions', async () => {
    const onSelect = vi.fn()

    await openNativeContextMenu({ items: [{ text: 'Unpin Note', action: onSelect }] })

    expect(menuNew).toHaveBeenCalledWith({
      items: [
        expect.objectContaining({
          text: 'Unpin Note',
        }),
      ],
    })
    expect(menuItemNew).toHaveBeenCalledWith({ text: 'Unpin Note', action: onSelect })
    expect(popup).toHaveBeenCalled()
    const item = firstMenuItem()
    item.action?.()
    expect(onSelect).toHaveBeenCalled()
  })

  it('renders separators as native dividers between rows', async () => {
    await openNativeContextMenu({
      items: [
        { text: 'Open', action: vi.fn() },
        NATIVE_MENU_SEPARATOR,
        { text: 'Unpin Note', action: vi.fn() },
      ],
    })

    expect(predefinedNew).toHaveBeenCalledExactlyOnceWith({ item: 'Separator' })
    expect(menuNew).toHaveBeenCalledWith({
      items: [
        expect.objectContaining({ text: 'Open' }),
        { item: 'Separator' },
        expect.objectContaining({ text: 'Unpin Note' }),
      ],
    })
  })
})
