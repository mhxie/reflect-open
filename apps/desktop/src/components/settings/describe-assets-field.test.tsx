import { page } from 'vitest/browser'
import { describe, expect, it, vi } from 'vitest'
import type { Settings } from '@reflect/core'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { DescribeAssetsField } from './describe-assets-field.tsx'

const PROVIDER = {
  id: 'cfg',
  provider: 'anthropic' as const,
  model: 'claude-opus-4-8',
  keyHint: 'wxyz1',
}

async function renderField(settings?: Partial<Settings>) {
  const view = await renderInApp(<DescribeAssetsField />, {
    graph: { generation: 5 },
    settings: {
      describeAssets: true,
      aiProviders: [PROVIDER],
      defaultAiProviderId: 'cfg',
      ...settings,
    },
  })
  const { app } = view
  return { view, app, backfill: vi.spyOn(app.assetDescription, 'backfillVisibly') }
}

describe('DescribeAssetsField', () => {
  it('offers a local OCR backfill for the selected vision model while the default AI is cloud', async () => {
    const local = {
      id: 'local',
      provider: 'openai-compatible',
      model: 'vision',
      keyHint: '',
      supportsImages: true,
      baseUrl: 'http://localhost:1234/v1',
      onDevice: {
        baseUrl: 'http://localhost:1234/v1',
        model: 'vision',
        server: 'openai-compatible',
      },
    } as const
    const { app, backfill } = await renderField({
      aiProviders: [PROVIDER, local],
      localOcrProviderId: 'local',
    })
    await page.getByRole('button', { name: /backfill assets/i }).click()
    await expect
      .element(page.getByText(/read by your selected local vision model/))
      .toBeInTheDocument()
    await page.getByRole('button', { name: /^backfill assets$/i }).click()
    // The pass reads the selected model from settings when it starts.
    expect(backfill).toHaveBeenCalledTimes(1)
    expect(app.settings.get().localOcrProviderId).toBe('local')
  })

  it('names the selected OCR model when closed, not its entry id', async () => {
    const local = {
      id: 'cfg-ollama-1234',
      provider: 'openai-compatible',
      model: 'gemma4:31b',
      keyHint: '',
      supportsImages: true,
      baseUrl: 'http://localhost:11434/v1',
      onDevice: { baseUrl: 'http://localhost:11434/v1', model: 'gemma4:31b', server: 'ollama' },
    } as const
    const select = page.getByRole('combobox', { name: 'OCR model' })

    const closedDefault = await renderField()
    await expect.element(select).toMatchTextContent('Default AI · public attachments only')
    await closedDefault.view.unmount()

    await renderField({ aiProviders: [PROVIDER, local], localOcrProviderId: local.id })
    await expect.element(select).toMatchTextContent('gemma4:31b · on this Mac')
    expect(select.element().textContent).not.toContain(local.id)
  })

  it('reflects and toggles the automatic OCR setting', async () => {
    const { app } = await renderField()
    const toggle = page.getByRole('switch', { name: /ocr new assets automatically/i })
    await expect.element(toggle).toHaveAttribute('aria-checked', 'true')
    await toggle.click()
    await vi.waitFor(() => expect(app.settings.get().describeAssets).toBe(false))
  })

  it('disables the backfill until an AI provider is configured', async () => {
    await renderField({ aiProviders: [], defaultAiProviderId: null })
    await expect.element(page.getByRole('button', { name: /backfill assets/i })).toBeDisabled()
    await expect.element(page.getByText(/add an ai provider to enable this/i)).toBeInTheDocument()
  })

  it('confirms the cost before running the backfill, then runs it', async () => {
    const { backfill } = await renderField()
    await page.getByRole('button', { name: /backfill assets/i }).click()

    // The cost warning appears; nothing is sent until the user confirms.
    await expect.element(page.getByText(/backfill assets\?/i)).toBeInTheDocument()
    expect(backfill).toHaveBeenCalledTimes(0)

    await page.getByRole('button', { name: /^backfill assets$/i }).click()
    expect(backfill).toHaveBeenCalledTimes(1)
  })

  it('cancels without sending anything', async () => {
    const { backfill } = await renderField()
    await page.getByRole('button', { name: /backfill assets/i }).click()
    await page.getByRole('button', { name: /cancel/i }).click()
    expect(backfill).toHaveBeenCalledTimes(0)
  })
})
