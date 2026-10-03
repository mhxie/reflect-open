import { describe, expect, it } from 'vitest'
import { addDaysIso } from '@reflect/utils'
import {
  activityLevel,
  activityThresholds,
  heatmapWeeks,
  monthLabelColumns,
} from './activity-scale.ts'

describe('activityThresholds', () => {
  const day = (date: string, characters: number) => ({ date, characters })

  it('uses quartiles once there is enough history', () => {
    const activity = Array.from({ length: 20 }, (_, index) =>
      day(addDaysIso('2026-01-01', index), (index + 1) * 10),
    )
    expect(activityThresholds(activity)).toEqual([60, 110, 160])
  })

  it('ignores repeated sizes, so templated days still spread across levels', () => {
    const activity = [
      ...Array.from({ length: 12 }, (_, index) => day(addDaysIso('2026-01-01', index), 50)),
      day('2026-02-01', 400),
    ]
    expect(activityThresholds(activity)).toEqual([100, 200, 300])
  })

  it('scales against the largest entry when history is short', () => {
    expect(activityThresholds([day('2026-10-01', 400)])).toEqual([100, 200, 300])
  })
})

describe('activityLevel', () => {
  const thresholds = [10, 20, 30] as const

  it('maps no entry to 0 and sizes to 1–4', () => {
    expect(activityLevel(undefined, thresholds)).toBe(0)
    expect(activityLevel(5, thresholds)).toBe(1)
    expect(activityLevel(20, thresholds)).toBe(2)
    expect(activityLevel(25, thresholds)).toBe(3)
    expect(activityLevel(31, thresholds)).toBe(4)
  })
})

describe('heatmapWeeks', () => {
  it('ends on the week holding today, starting each column on the week start', () => {
    // 2026-10-03 is a Saturday.
    const mondayWeeks = heatmapWeeks('2026-10-03', 2, 1)
    expect(mondayWeeks).toHaveLength(3)
    expect(mondayWeeks[2]![0]).toBe('2026-09-28')
    expect(mondayWeeks[2]).toContain('2026-10-03')
    expect(mondayWeeks[0]![0]).toBe('2026-09-14')

    const sundayWeeks = heatmapWeeks('2026-10-03', 0, 0)
    expect(sundayWeeks[0]).toEqual([
      '2026-09-27',
      '2026-09-28',
      '2026-09-29',
      '2026-09-30',
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
    ])
  })
})

describe('monthLabelColumns', () => {
  it('labels each column that starts a new month', () => {
    // Monday-start columns from 2026-07-06 to 2026-10-03.
    const weeks = heatmapWeeks('2026-10-03', 12, 1)
    expect(monthLabelColumns(weeks).map((column) => weeks[column]![0])).toEqual([
      '2026-07-06',
      '2026-08-03',
      '2026-09-07',
    ])
  })

  it('drops the first column when the next month label would crowd it', () => {
    // Columns start 2026-09-28, 10-05, 10-12: October begins one column in.
    const weeks = heatmapWeeks('2026-10-14', 2, 1)
    expect(monthLabelColumns(weeks)).toEqual([1])
  })
})
