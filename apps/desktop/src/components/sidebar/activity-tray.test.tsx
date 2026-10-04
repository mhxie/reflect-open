import { cleanup, render } from 'vitest-browser-react'
import { page, userEvent } from 'vitest/browser'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setIndexProgress } from '@/lib/index-progress.ts'
import { resetOperations, startOperation } from '@/lib/operations.ts'
import { setSemanticIndexProgress } from '@/lib/semantic-index-progress.ts'
import '@/test-utils/locator.ts'
import { ActivityTray } from './activity-tray.tsx'

beforeEach(() => {
  resetOperations()
  setIndexProgress(null)
  setSemanticIndexProgress(null)
})

afterEach(async () => {
  await cleanup()
  resetOperations()
  setIndexProgress(null)
  setSemanticIndexProgress(null)
})

const trigger = () => page.getByRole('button', { name: /^Activity/ })

describe('ActivityTray', () => {
  it('stays hidden with nothing to show', async () => {
    const view = await render(<ActivityTray />)

    expect(view.container.querySelector('button')).toBeNull()
  })

  it('gathers background work in progress', async () => {
    await render(<ActivityTray />)
    const handle = startOperation('Describing assets', { background: true })
    handle.progress(1, 4)
    setSemanticIndexProgress({ done: 30, total: 120 })
    setIndexProgress({ done: 500, total: 2000, worked: 400 })

    await expect.element(page.getByRole('button', { name: 'Activity: 3 running' })).toBeVisible()
    await userEvent.click(trigger())

    const running = page.getByRole('region', { name: 'In progress' })
    await expect.element(running.getByText('Describing assets')).toBeVisible()
    await expect.element(running.getByText('1 / 4')).toBeVisible()
    await expect.element(running.getByText('Building the semantic index')).toBeVisible()
    await expect.element(running.getByText('Indexing notes')).toBeVisible()
  })

  it('leaves a quick index pass and foreground operations out', async () => {
    const view = await render(<ActivityTray />)
    startOperation('Copying the reply')
    setIndexProgress({ done: 50, total: 2000, worked: 0 })

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(view.container.querySelector('button')).toBeNull()
  })

  it('flags problems, which can be dismissed, and lists finished work', async () => {
    await render(<ActivityTray />)
    startOperation('Backing up').fail('Too large to back up (kept local): big.mov')
    startOperation('Rebuilding search index', { background: true }).dismiss()

    await expect
      .element(page.getByRole('button', { name: 'Activity: 1 need attention' }))
      .toBeVisible()
    await userEvent.click(trigger())

    const attention = page.getByRole('region', { name: 'Needs attention' })
    await expect
      .element(attention.getByText('Too large to back up (kept local): big.mov'))
      .toBeVisible()
    await expect
      .element(page.getByRole('region', { name: 'Recent' }).getByText('Rebuilding search index'))
      .toBeVisible()

    await userEvent.click(attention.getByRole('button', { name: 'Dismiss Backing up' }))
    await expect
      .element(page.getByRole('region', { name: 'Needs attention' }))
      .not.toBeInTheDocument()
  })
})
