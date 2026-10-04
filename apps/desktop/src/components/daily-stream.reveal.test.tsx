import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { afterEach, expect, it, vi } from 'vitest'
import { useEffect, type ReactElement } from 'react'
import { setBridge } from '@reflect/core'
import { addDaysIso, todayIso } from '@/lib/dates.ts'
import type { NoteReveal } from '@/lib/note-reveal.ts'
import { RouterProvider, useRouter } from '@/routing/router.tsx'
import '@/test-utils/locator.ts'
import { DailyStream } from './daily-stream.tsx'

/**
 * A followed `[[YYYY-MM-DD#Heading]]` link: the stream hands the heading to
 * the arrival day's pane, and to no other day.
 */

/** Every reveal a day's pane was asked for, in order. */
const reveals = vi.hoisted(() => [] as { date: string; fragment: string }[])

vi.mock('@/components/note-pane.tsx', async () => {
  const { useEffect } = await import('react')
  return {
    NotePane: ({
      dailyDate,
      reveal,
      onRevealed,
    }: {
      dailyDate?: string
      reveal?: NoteReveal
      onRevealed?: (key: number) => void
    }) => {
      useEffect(() => {
        if (reveal !== undefined) {
          reveals.push({ date: dailyDate ?? '', fragment: reveal.fragment })
          onRevealed?.(reveal.key)
        }
      }, [reveal, onRevealed, dailyDate])
      return <div data-testid={`pane-${dailyDate ?? ''}`} data-reveal={reveal?.fragment ?? ''} />
    },
  }
})
vi.mock('@/providers/settings-provider.tsx', () => ({
  useSettings: () => ({
    settings: { dateFormat: 'mdy' },
    updateSettings: async () => {},
    updateSettingsWith: () => {},
  }),
}))

setBridge({ invoke: () => new Promise(() => {}), listen: async () => () => {} })

afterEach(async () => {
  await cleanup()
})

function FollowDayLink({ date }: { date: string }): null {
  const { navigate } = useRouter()
  useEffect(() => {
    navigate({ kind: 'daily', date }, { revealHeading: 'Agenda' })
  }, [navigate, date])
  return null
}

function Stream(): ReactElement {
  const { route } = useRouter()
  return (
    <DailyStream
      target={route.kind === 'daily' ? { kind: 'date', date: route.date } : { kind: 'today' }}
    />
  )
}

it('reveals the linked heading in the arrival day only, once', async () => {
  reveals.length = 0
  const yesterday = addDaysIso(todayIso(), -1)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await render(
    <QueryClientProvider client={client}>
      <RouterProvider initialRoute={{ kind: 'today' }}>
        <div style={{ height: 800 }}>
          <Stream />
        </div>
        <FollowDayLink date={yesterday} />
      </RouterProvider>
    </QueryClientProvider>,
  )

  await vi.waitFor(() => expect(reveals).toEqual([{ date: yesterday, fragment: 'Agenda' }]))
  // Once the pane has scrolled, the stream stops asking, so a remount won't.
  await expect.element(page.getByTestId(`pane-${yesterday}`)).toHaveAttribute('data-reveal', '')
  expect(reveals).toHaveLength(1)
})
