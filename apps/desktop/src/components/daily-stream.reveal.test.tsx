import { createTestCoreServices } from '@reflect/core/testing'
import { page } from 'vitest/browser'
import { expect, it, onTestFinished, vi } from 'vitest'
import { useEffect, type ReactElement } from 'react'
import { addDaysToIsoDate, getIsoToday } from '@reflect/utils'
import type { NoteReveal } from '@/lib/note-reveal.ts'
import { useRouter } from '@/routing/router.tsx'
import '@/test-utils/locator.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
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
  const yesterday = addDaysToIsoDate(getIsoToday(), -1)
  const app = createTestCoreServices({ database: createWasmTestDatabaseService() })
  onTestFinished(() => app.database.close())
  // The stream's today is the clock's; the link targets the real yesterday.
  app.clock.setNow(Date.now())
  await renderInApp(
    <>
      <div style={{ height: 800 }}>
        <Stream />
      </div>
      <FollowDayLink date={yesterday} />
    </>,
    { core: app, route: { kind: 'today' }, settings: { dateFormat: 'mdy' } },
  )

  await vi.waitFor(() => expect(reveals).toEqual([{ date: yesterday, fragment: 'Agenda' }]))
  // Once the pane has scrolled, the stream stops asking, so a remount won't.
  await expect.element(page.getByTestId(`pane-${yesterday}`)).toHaveAttribute('data-reveal', '')
  expect(reveals).toHaveLength(1)
})
