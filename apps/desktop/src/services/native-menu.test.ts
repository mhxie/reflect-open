import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NATIVE_MENU_SEPARATOR, type NativeSubmenu } from '@reflect/app'

interface SubmenuOptionsForTest {
  readonly text: string
  readonly items: readonly unknown[]
}

const calls = vi.hoisted((): string[] => [])
const popup = vi.hoisted(() => vi.fn(async () => {}))
const setAsAppMenu = vi.hoisted(() =>
  vi.fn(async () => {
    calls.push('setAsAppMenu')
  }),
)
const submenuNew = vi.hoisted(() =>
  vi.fn(async (options: SubmenuOptionsForTest) => ({
    setAsWindowsMenuForNSApp: async () => {
      calls.push(`windows:${options.text}`)
    },
    setAsHelpMenuForNSApp: async () => {
      calls.push(`help:${options.text}`)
    },
  })),
)
const menuNew = vi.hoisted(() => vi.fn(async (_options: unknown) => ({ setAsAppMenu, popup })))
const menuItemNew = vi.hoisted(() =>
  vi.fn(async (options: object) => ({ ...options, built: true })),
)
const predefinedNew = vi.hoisted(() => vi.fn(async (options: { item: string }) => options))

vi.mock('@tauri-apps/api/menu', () => ({
  Menu: { new: menuNew },
  MenuItem: { new: menuItemNew },
  PredefinedMenuItem: { new: predefinedNew },
  Submenu: { new: submenuNew },
}))

const { createTauriNativeMenuHost } = await import('./native-menu.ts')

beforeEach(() => {
  vi.clearAllMocks()
  calls.length = 0
})

describe('createTauriNativeMenuHost', () => {
  const action = vi.fn()
  const layout: NativeSubmenu[] = [
    {
      text: 'View',
      items: [
        {
          kind: 'command',
          id: 'sidebar.toggle',
          text: 'Toggle sidebar',
          accelerator: 'CmdOrCtrl+\\',
          action,
        },
        { kind: 'predefined', item: 'Separator' },
        { kind: 'command', id: 'theme.toggle', text: 'Toggle theme', action },
        { kind: 'predefined', item: 'Quit', text: 'Quit Reflect' },
      ],
    },
    { text: 'Window', nsAppRole: 'windows', items: [{ kind: 'predefined', item: 'Minimize' }] },
    { text: 'Help', nsAppRole: 'help', items: [] },
  ]

  it('builds command items as menu items, so that they keep their click handler', async () => {
    await createTauriNativeMenuHost().buildAppMenu(layout)

    const sidebarToggle = {
      id: 'sidebar.toggle',
      text: 'Toggle sidebar',
      accelerator: 'CmdOrCtrl+\\',
      action,
    }
    const themeToggle = { id: 'theme.toggle', text: 'Toggle theme', action }
    expect(menuItemNew.mock.calls).toEqual([[sidebarToggle], [themeToggle]])
    // Submenus build concurrently, so the calls are in no fixed order.
    const view = submenuNew.mock.calls
      .map(([options]) => options)
      .find((options) => options.text === 'View')
    expect(view).toEqual({
      text: 'View',
      items: [
        { ...sidebarToggle, built: true },
        { item: 'Separator' },
        { ...themeToggle, built: true },
        { item: 'Quit', text: 'Quit Reflect' },
      ],
    })
    expect(menuNew).toHaveBeenCalledTimes(1)
    expect(setAsAppMenu).not.toHaveBeenCalled()
  })

  it('installs the menu and assigns the NSApp roles only when asked', async () => {
    const menu = await createTauriNativeMenuHost().buildAppMenu(layout)
    expect(calls).toEqual([])

    await menu.setAsAppMenu()
    expect(calls).toEqual(['setAsAppMenu'])

    await menu.assignNsAppRoles()
    expect(calls).toEqual(['setAsAppMenu', 'windows:Window', 'help:Help'])
  })

  it('pops up a context menu whose items run their actions', async () => {
    const onSelect = vi.fn()

    await createTauriNativeMenuHost().popup([{ text: 'Unpin Note', action: onSelect }])

    expect(menuItemNew).toHaveBeenCalledWith({ text: 'Unpin Note', action: onSelect })
    expect(menuNew).toHaveBeenCalledWith({
      items: [{ text: 'Unpin Note', action: onSelect, built: true }],
    })
    expect(popup).toHaveBeenCalledTimes(1)
  })

  it('renders context menu separators as native dividers between rows', async () => {
    const open = vi.fn()
    const unpin = vi.fn()

    await createTauriNativeMenuHost().popup([
      { text: 'Open', action: open },
      NATIVE_MENU_SEPARATOR,
      { text: 'Unpin Note', action: unpin },
    ])

    expect(predefinedNew).toHaveBeenCalledExactlyOnceWith({ item: 'Separator' })
    expect(menuNew).toHaveBeenCalledWith({
      items: [
        { text: 'Open', action: open, built: true },
        { item: 'Separator' },
        { text: 'Unpin Note', action: unpin, built: true },
      ],
    })
  })
})
