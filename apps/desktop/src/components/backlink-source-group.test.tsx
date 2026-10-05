import { render } from 'vitest-browser-react'
import { page, userEvent } from 'vitest/browser'
import { describe, expect, it, vi } from 'vitest'
import { isModEvent } from '@meowdown/core'
import type { BacklinkSource } from '@/lib/group-backlinks.ts'
import { BacklinkSourceGroup } from './backlink-source-group.tsx'

const SOURCE: BacklinkSource = {
  hasConflict: false,
  path: 'notes/source.md',
  title: 'Source Note',
  isPrivate: false,
  snippets: [],
}

type OnOpen = (path: string, event?: { metaKey: boolean; ctrlKey: boolean }) => void

function mount(onOpen: OnOpen, source: BacklinkSource = SOURCE) {
  return render(
    <BacklinkSourceGroup
      source={source}
      first
      expanded={false}
      onOpen={onOpen}
      onWikilinkClick={() => {}}
    />,
  )
}

describe('BacklinkSourceGroup', () => {
  it.each([
    { isPrivate: true, hasConflict: false, label: 'Private' },
    { isPrivate: false, hasConflict: true, label: 'Protected' },
  ])(
    'shows $label source metadata and keeps Enter navigation on the parent button',
    async ({ isPrivate, hasConflict, label }) => {
      const onOpen = vi.fn<OnOpen>()
      await mount(onOpen, { ...SOURCE, isPrivate, hasConflict })
      const button = page.getByRole('button', { name: `${label} Source Note`, exact: true })
      await expect.element(button.getByRole('img', { name: label, exact: true })).toBeVisible()
      expect(button.element().querySelector('button')).toBeNull()
      button.element().focus()
      await userEvent.keyboard('{Enter}')
      expect(onOpen).toHaveBeenCalledWith(SOURCE.path, expect.anything())
    },
  )

  it('forwards the click event so ⌘-click can open a new window', async () => {
    const onOpen = vi.fn<OnOpen>()
    await mount(onOpen)

    await page.getByRole('button', { name: 'Source Note' }).click({ modifiers: ['ControlOrMeta'] })

    expect(onOpen).toHaveBeenCalledTimes(1)
    const [path, event] = onOpen.mock.calls[0]!
    expect(path).toBe('notes/source.md')
    // The platform's mod key: Meta on mac dev machines, Ctrl on Linux CI.
    expect(event !== undefined && isModEvent(event)).toBe(true)
  })

  it('plain clicks arrive without the modifier', async () => {
    const onOpen = vi.fn<OnOpen>()
    await mount(onOpen)

    await page.getByRole('button', { name: 'Source Note' }).click()

    const [, event] = onOpen.mock.calls[0]!
    expect(event !== undefined && isModEvent(event)).toBe(false)
  })
})
