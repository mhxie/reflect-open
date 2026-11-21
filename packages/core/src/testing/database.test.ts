import { describe, expect, it } from 'vitest'
import { createTestDatabaseService, seedNotes } from './database.ts'

describe('createTestDatabaseService', () => {
  it('reads back seeded notes', async () => {
    const database = createTestDatabaseService()
    seedNotes(database, [
      { path: 'notes/b.md', markdown: '# B\n' },
      { path: 'notes/a.md', markdown: '# A\n' },
    ])

    const rows = await database.db.selectFrom('notes').select('path').orderBy('path').execute()
    expect(rows.map((row) => row.path)).toEqual(['notes/a.md', 'notes/b.md'])
    database.close()
  })

  it('rejects queries and seeding after close', async () => {
    const database = createTestDatabaseService()
    database.close()

    await expect(database.runQuery('select 1', [])).rejects.toMatchObject({
      kind: 'unknown',
      message: 'the test database is closed',
    })
    expect(() => seedNotes(database, [{ path: 'notes/a.md', markdown: '# A\n' }])).toThrow(
      'the test database is closed',
    )
  })
})
