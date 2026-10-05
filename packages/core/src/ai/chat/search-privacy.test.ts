import { afterEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { getBridge, setBridge } from '../../ipc/bridge.ts'
import {
  applyProjection,
  connectIndex,
  openMigratedIndex,
  project,
} from '../../indexing/flow-test-harness.ts'
import { hasRestrictedSearchSources } from './search-privacy.ts'
import { hashContent } from '../../indexing/hash.ts'

let database: DatabaseSync | null = null

afterEach(() => {
  setBridge(null)
  database?.close()
  database = null
})

describe('live search source privacy', () => {
  it('checks the hit snapshot when an old bare source disappears and a public replacement takes its name', async () => {
    const source = '![[scan.png]]'
    database = openMigratedIndex()
    applyProjection(database, project('notes/a.md', source, 1))
    database
      .prepare('INSERT INTO assets(note_path, asset_path) VALUES (?, ?)')
      .run('notes/a.md', 'scan.png')
    database
      .prepare('UPDATE notes SET asset_text_hash = ? WHERE path = ?')
      .run(await hashContent('New public caption'), 'notes/a.md')
    connectIndex(database)
    const bridge = getBridge()
    setBridge({
      ...bridge,
      invoke: (command, args) =>
        command === 'list_attachments'
          ? Promise.resolve([{ path: 'notes/scan.png', size: 1, modifiedMs: 1 }])
          : bridge.invoke(command, args),
    })
    const read = async (path: string): Promise<string> => {
      if (path === 'notes/a.md') return source
      if (path === 'notes/scan.png.reflect.md') return 'New public caption'
      if (path === 'assets/scan.png.reflect.md') return '---\nprivate: true\n---\nOld caption'
      throw { kind: 'notFound', message: 'missing' }
    }
    expect(
      await hasRestrictedSearchSources(
        'notes/a.md',
        source,
        read,
        7,
        await hashContent('Old caption'),
      ),
    ).toBe(true)
    expect(
      await hasRestrictedSearchSources(
        'notes/a.md',
        source,
        read,
        7,
        await hashContent('New public caption'),
      ),
    ).toBe(false)
  })

  it('withholds an unresolved bare reference after its caption source disappears', async () => {
    const source = '![[scan.png]]'
    database = openMigratedIndex()
    applyProjection(database, project('notes/a.md', source, 1))
    connectIndex(database)
    const bridge = getBridge()
    setBridge({
      ...bridge,
      invoke: (command, args) =>
        command === 'list_attachments' ? Promise.resolve([]) : bridge.invoke(command, args),
    })
    const read = async (path: string): Promise<string> => {
      if (path === 'notes/a.md') return source
      if (path === 'assets/scan.png.reflect.md')
        return '---\nprivate: true\n---\nPreviously public caption'
      throw { kind: 'notFound', message: 'missing' }
    }
    expect(await hasRestrictedSearchSources('notes/a.md', source, read, 7)).toBe(true)
  })

  it('checks the earlier bare-reference candidate when a new file takes resolution precedence', async () => {
    const source = '![[scan.png]]'
    database = openMigratedIndex()
    applyProjection(database, project('notes/a.md', source, 1))
    database
      .prepare('INSERT INTO assets(note_path, asset_path) VALUES (?, ?)')
      .run('notes/a.md', 'scan.png')
    connectIndex(database)
    const bridge = getBridge()
    setBridge({
      ...bridge,
      invoke: (command, args) =>
        command === 'list_attachments'
          ? Promise.resolve([
              { path: 'assets/scan.png', size: 1, modifiedMs: 1 },
              { path: 'notes/scan.png', size: 1, modifiedMs: 1 },
            ])
          : bridge.invoke(command, args),
    })
    const read = async (path: string): Promise<string> => {
      if (path === 'notes/a.md') return source
      if (path === 'assets/scan.png.reflect.md')
        return '---\nprivate: true\n---\nPreviously folded caption'
      if (path === 'notes/scan.png.reflect.md') return 'New public caption'
      throw { kind: 'notFound', message: 'missing' }
    }
    expect(await hasRestrictedSearchSources('notes/a.md', source, read, 7)).toBe(true)
  })
})
