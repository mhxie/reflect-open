import { isTauri } from '@tauri-apps/api/core'
import { Menu, MenuItem, PredefinedMenuItem } from '@tauri-apps/api/menu'

/** A selectable row in a native context menu. */
export interface NativeContextMenuAction {
  /** Visible native menu item label. */
  readonly text: string
  /** Invoked when the native menu item is selected. */
  readonly action: () => void
}

/** A divider between groups of native context menu rows. */
export interface NativeContextMenuSeparator {
  readonly separator: true
}

export type NativeContextMenuItem = NativeContextMenuAction | NativeContextMenuSeparator

export interface NativeContextMenuOptions {
  /** Menu items to render in order. */
  items: readonly NativeContextMenuItem[]
}

/** The divider entry, shared so call sites read as a list of rows. */
export const NATIVE_MENU_SEPARATOR: NativeContextMenuSeparator = { separator: true }

function isSeparator(item: NativeContextMenuItem): item is NativeContextMenuSeparator {
  return 'separator' in item
}

/**
 * Open a Tauri native context menu. Outside Tauri, this is a no-op so browser
 * and test shells can call the same path without platform guards.
 */
export async function openNativeContextMenu(options: NativeContextMenuOptions): Promise<void> {
  if (!isTauri()) {
    return
  }

  const items = await Promise.all(
    options.items.map((item) =>
      isSeparator(item)
        ? PredefinedMenuItem.new({ item: 'Separator' })
        : MenuItem.new({ text: item.text, action: item.action }),
    ),
  )
  const menu = await Menu.new({ items })
  await menu.popup()
}
