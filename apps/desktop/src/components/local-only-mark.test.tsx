import { cleanup, render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@/test-utils/locator.ts'
import { LocalOnlyMark } from './local-only-mark.tsx'

vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  // The graph's local-only folder is `secure` (the predicate is covered in core).
  isLocalOnlyPath: (path: string) => path.split('/').slice(0, -1).includes('secure'),
}))

afterEach(async () => {
  await cleanup()
})

describe('LocalOnlyMark', () => {
  it('marks a note inside a local-only folder', async () => {
    await render(<LocalOnlyMark path="finance/secure/bank.md" />)

    await expect.element(page.getByRole('img', { name: 'Local-only' })).toBeInTheDocument()
  })

  it('renders nothing for any other note', async () => {
    const view = await render(<LocalOnlyMark path="notes/plan.md" />)

    expect(view.container.querySelector('svg')).toBeNull()
  })
})
