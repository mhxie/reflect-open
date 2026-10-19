import { describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { useRouter } from '@/routing/router.tsx'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { useTagNavigation } from './use-tag-navigation.ts'

let lastHandler: ((tag: string) => void) | null = null

function Host(): ReactNode {
  lastHandler = useTagNavigation()
  return null
}

function RouteProbe(): ReactNode {
  const { route } = useRouter()
  return <output data-testid="route">{JSON.stringify(route)}</output>
}

function renderHost() {
  return renderInApp(
    <>
      <Host />
      <RouteProbe />
    </>,
  )
}

function currentRoute(view: Awaited<ReturnType<typeof renderHost>>): string {
  return view.getByTestId('route').element().textContent ?? ''
}

describe('useTagNavigation', () => {
  it('opens All Notes filtered by the clicked tag', async () => {
    const view = await renderHost()
    lastHandler?.('book')
    await vi.waitFor(() => {
      expect(JSON.parse(currentRoute(view))).toEqual({
        kind: 'allNotes',
        filter: { kind: 'tag', tag: 'book' },
      })
    })
  })
})
