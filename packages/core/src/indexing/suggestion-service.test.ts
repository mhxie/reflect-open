import { describe, expect, it } from 'vitest'
import {
  createTestDatabaseService,
  seedNotes,
  type TestDatabaseService,
  type TestNote,
} from '../testing/database.ts'
import { createSuggestionService } from './suggestion-service.ts'

function seeded(notes: readonly TestNote[]): TestDatabaseService {
  const database = createTestDatabaseService()
  seedNotes(database, notes)
  return database
}

describe('suggestTags', () => {
  it('suggests tags containing the folded query, most-used first, never from templates', async () => {
    const database = seeded([
      { path: 'notes/a.md', markdown: '# A\n#Reading #ready\n' },
      { path: 'notes/b.md', markdown: '# B\n#reading\n' },
      { path: 'notes/c.md', markdown: '# C\n#unrelated #a_b #axb\n' },
      { path: 'templates/t.md', markdown: '# T\n#readme #readme-too\n' },
    ])
    const suggestions = createSuggestionService({ database })

    await expect(suggestions.suggestTags('READ')).resolves.toEqual([
      { tag: 'Reading', count: 2 },
      { tag: 'ready', count: 1 },
    ])
    await expect(suggestions.suggestTags('a_b')).resolves.toEqual([{ tag: 'a_b', count: 1 }])
    await expect(suggestions.suggestTags('', 1)).resolves.toEqual([{ tag: 'Reading', count: 2 }])
  })
})

describe('suggestWikiTargets', () => {
  it.each([
    ['title', { path: 'notes/unique.md', markdown: '---\nprivate: true\n---\n# Unique\n' }],
    [
      'alias',
      { path: 'notes/other.md', markdown: '---\nprivate: true\naliases: [Unique]\n---\n# Other\n' },
    ],
  ] as const)(
    'carries Private metadata from %s candidates without more queries',
    async (_source, note) => {
      const database = seeded([note])

      const result = await createSuggestionService({ database }).suggestWikiTargets('unique')

      expect(result[0]).toMatchObject({ path: note.path, isPrivate: true })
      const queries = database.getQueries()
      expect(queries).toHaveLength(2)
      for (const query of queries) {
        expect(query.sql).toContain('"is_private"')
      }
    },
  )

  it('carries the display title and language of a localized note', async () => {
    const database = seeded([{ path: 'notes/tokyo.md', markdown: '---\nlang: ja\n---\n# 東京\n' }])

    const [suggestion] = await createSuggestionService({ database }).suggestWikiTargets('東京')

    expect(suggestion).toMatchObject({ path: 'notes/tokyo.md', displayTitle: '東京', lang: 'ja' })
  })

  // Wednesday, 1 January 2020, day/month — the date generator's worked-example
  // clock. This exercises the live glue (generator + merge) the editor hits;
  // the parts themselves are unit-tested in date-suggestions/suggest.
  const clock = { today: '2020-01-01', dateFormat: 'dmy' as const, weekStartDay: 'monday' as const }

  it('synthesises a daily target from a fuzzy query when given a clock', async () => {
    const database = createTestDatabaseService()

    await expect(
      createSuggestionService({ database }).suggestWikiTargets('3 days ago', 8, clock),
    ).resolves.toEqual([
      {
        target: '2019-12-29',
        path: null,
        title: '2019-12-29',
        alias: null,
        date: '2019-12-29',
        generated: { phrase: '3 days ago' },
      },
    ])
  })

  it('keeps an exact title match above the generated date (folded key threaded into the merge)', async () => {
    const database = seeded([
      {
        path: 'notes/today.md',
        markdown: '---\nprivate: true\n---\n# Today\n',
      },
    ])

    const result = await createSuggestionService({ database }).suggestWikiTargets('today', 8, clock)

    expect(result.map((row) => row.target)).toEqual(['Today', '2020-01-01'])
    expect(result[0]!.path).toBe('notes/today.md')
    expect(result[0]).toMatchObject({ isPrivate: true })
    // A generated date has no indexed file, so no note flags.
    expect(result[1]).not.toHaveProperty('isPrivate')
    expect(result[1]).toMatchObject({
      date: '2020-01-01',
      generated: { phrase: 'Today' },
      path: null,
    })
  })

  it('does not synthesise dates without a clock', async () => {
    const database = createTestDatabaseService()
    await expect(
      createSuggestionService({ database }).suggestWikiTargets('today'),
    ).resolves.toEqual([])
  })

  it('still injects the bare daily for a full ISO query without a clock', async () => {
    const database = createTestDatabaseService()
    await expect(
      createSuggestionService({ database }).suggestWikiTargets('2020-01-01'),
    ).resolves.toEqual([
      { target: '2020-01-01', path: null, title: '2020-01-01', alias: null, date: '2020-01-01' },
    ])
  })

  it('excludes templates from both the title and alias candidates', async () => {
    const database = seeded([
      { path: 'templates/journal.md', markdown: '---\naliases: [Journal alias]\n---\n# Journal\n' },
      { path: 'notes/journal-log.md', markdown: '# Journal log\n' },
    ])

    const result = await createSuggestionService({ database }).suggestWikiTargets('journal')

    expect(result.map((row) => row.path)).toEqual(['notes/journal-log.md'])
  })
})
