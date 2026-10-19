import { page, userEvent } from 'vitest/browser'
import { describe, expect, it } from 'vitest'
import { act } from '@/test-utils/act.ts'
import '@/test-utils/locator.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { ActivityTray } from './activity-tray.tsx'

const trigger = () => page.getByRole('button', { name: /^Activity/ })

describe('ActivityTray', () => {
  it('stays hidden with nothing to show', async () => {
    const view = await renderInApp(<ActivityTray />)

    expect(view.container.querySelector('button')).toBeNull()
  })

  it('gathers background work in progress', async () => {
    const view = await renderInApp(<ActivityTray />)
    await act(() => {
      const handle = view.appServices.operations.start('Describing assets', { background: true })
      handle.progress(1, 4)
      view.app.semanticSearch.setIndexProgress({ done: 30, total: 120 })
      view.app.indexLifecycle.setFileProgress({ done: 500, total: 2000, worked: 400 })
    })

    await expect.element(page.getByRole('button', { name: 'Activity: 3 running' })).toBeVisible()
    await userEvent.click(trigger())

    const running = page.getByRole('region', { name: 'In progress' })
    await expect.element(running.getByText('Describing assets')).toBeVisible()
    await expect.element(running.getByText('1 / 4')).toBeVisible()
    await expect.element(running.getByText('Building the semantic index')).toBeVisible()
    await expect.element(running.getByText('Indexing notes')).toBeVisible()
  })

  it('leaves a quick index pass and foreground operations out', async () => {
    const view = await renderInApp(<ActivityTray />)
    await act(() => {
      view.appServices.operations.start('Copying the reply')
      view.app.indexLifecycle.setFileProgress({ done: 50, total: 2000, worked: 0 })
    })

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(view.container.querySelector('button')).toBeNull()
  })

  it('flags problems, which can be dismissed, and lists finished work', async () => {
    const view = await renderInApp(<ActivityTray />)
    await act(() => {
      const { operations } = view.appServices
      operations.start('Backing up').fail('Too large to back up (kept local): big.mov')
      operations.start('Rebuilding search index', { background: true }).dismiss()
    })

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
