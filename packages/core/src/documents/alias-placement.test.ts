import { describe, expect, it, vi } from 'vitest'
import { upsertFrontmatter } from '../markdown/frontmatter.ts'
import { createTestNoteSession } from '../testing/documents.ts'
import { createTestFileChangeService } from '../testing/file-change.ts'
import { createTestNoteFileService } from '../testing/graph.ts'
import { moveDeclaredTitle, placeOldTitleAlias } from './alias-placement.ts'
import { createOpenDocumentsService } from './open-documents-service.ts'

/**
 * The pure helpers (`parseNote`, `nextAliases`, `upsertFrontmatter`) stay real
 * so the alias math is exercised, not restated — the same split as the
 * coordinator tests. The note-file double refuses a write whose expected
 * bytes the file no longer holds, so a landed disk write is a checked one.
 */

const PATH = 'notes/subject.md'
const RENAME = { from: 'Old Title', to: 'New Title', previousAutoAliases: [] }
const GENERATION = 7
const CHANGED_ON_DISK = { kind: 'io', message: 'Note changed on disk; reload before retrying' }

function setup(options?: {
  /**
   * The file at `PATH`; `null` leaves it missing. Defaults to `# Old Title` with a body.
   */
  disk?: string | null
  /**
   * The open session's buffer; without it no session is open. `null` opens
   * one that is still loading.
   */
  session?: string | null
  /**
   * False makes the session refuse the patch. Defaults to true.
   */
  takesPatch?: boolean
  /**
   * The file generation the open session writes with. Defaults to `GENERATION`.
   */
  sessionGeneration?: number
  /**
   * The file generation the graph is on; reads pinned to another reject.
   */
  graphGeneration?: number
}) {
  const disk = options?.disk === undefined ? '# Old Title\n\nbody\n' : options.disk
  const noteFile = createTestNoteFileService({
    files: disk === null ? {} : { [PATH]: disk },
    ...(options?.graphGeneration === undefined ? {} : { generation: options.graphGeneration }),
  })
  const session =
    options?.session === undefined
      ? null
      : createTestNoteSession({
          path: PATH,
          ...(options.session === null ? { loaded: false } : { content: options.session }),
          accepts: options.takesPatch ?? true,
          generation: options.sessionGeneration ?? GENERATION,
        })
  const openDocuments = createOpenDocumentsService({ fileChanges: createTestFileChangeService() })
  if (session !== null) {
    openDocuments.register({ session })
  }
  return { deps: { noteFile, openDocuments }, noteFile, session }
}

describe('placeOldTitleAlias', () => {
  it('refuses to put an old private title into another graph’s same-path live session', async () => {
    // The open pane belongs to graph 8; the rename was issued in graph 7.
    const { deps, noteFile, session } = setup({
      session: '# Public note\n',
      sessionGeneration: 8,
      graphGeneration: 8,
    })

    await expect(
      placeOldTitleAlias(deps, PATH, { ...RENAME, from: 'Private account title' }, GENERATION),
    ).rejects.toThrow('the graph changed since this command was issued')

    expect(session!.getCalls('updateFrontmatter')).toEqual([])
    expect(session!.getCalls('flush')).toEqual([])
    expect(noteFile.writes()).toEqual([])
  })

  it('with no live session, patches the alias straight onto disk at the generation', async () => {
    const { deps, noteFile } = setup()

    await placeOldTitleAlias(deps, PATH, RENAME, GENERATION)

    // Checked against the text the aliases were computed from: the double
    // lands only a write whose expected bytes the file still holds.
    expect(noteFile.writes()).toEqual([
      {
        path: PATH,
        contents: upsertFrontmatter('# Old Title\n\nbody\n', { aliases: ['Old Title'] }),
        generation: GENERATION,
      },
    ])
    expect(noteFile.writes()[0]!.contents).toContain('# Old Title\n\nbody\n') // body untouched
  })

  it('recomputes the aliases over a concurrent change instead of clobbering it', async () => {
    const gained = '---\naliases:\n  - Gained Elsewhere\n---\n# Old Title\n\nbody\n'
    const { deps, noteFile } = setup()
    vi.spyOn(noteFile, 'read').mockImplementationOnce(async () => {
      // Another writer lands between this read and the write it feeds.
      noteFile.set(PATH, gained)
      return '# Old Title\n\nbody\n'
    })
    const writes = vi.spyOn(noteFile, 'write')

    const added = await placeOldTitleAlias(deps, PATH, RENAME, GENERATION)

    expect(added).toEqual(['Old Title'])
    expect(writes).toHaveBeenCalledTimes(2)
    const [, contents, , expected] = writes.mock.calls[1]!
    expect(contents).toContain('Gained Elsewhere')
    expect(contents).toContain('Old Title')
    expect(expected).toBe(gained)
    expect(noteFile.files().get(PATH)).toBe(contents)
  })

  it('surfaces the conflict after three refused writes', async () => {
    const { deps, noteFile } = setup()
    let version = 0
    // Every read sees a newer version than the file the write is checked against.
    vi.spyOn(noteFile, 'read').mockImplementation(async () => `# Old Title\n\nv${version++}\n`)
    const writes = vi.spyOn(noteFile, 'write')

    await expect(placeOldTitleAlias(deps, PATH, RENAME, GENERATION)).rejects.toMatchObject(
      CHANGED_ON_DISK,
    )
    expect(writes).toHaveBeenCalledTimes(3)
    expect(noteFile.writes()).toEqual([])
  })

  it('routes through a live session: frontmatter channel, then flush, no disk write', async () => {
    const { deps, noteFile, session } = setup({ disk: null, session: '# Old Title\n\nbody\n' })

    await placeOldTitleAlias(deps, PATH, RENAME, GENERATION)

    expect(session!.getCalls('updateFrontmatter')).toEqual([[{ aliases: ['Old Title'] }]])
    expect(session!.getCalls('flush')).toHaveLength(1)
    expect(noteFile.writes()).toEqual([])
  })

  it('falls back to disk when the session cannot take the patch', async () => {
    const { deps, noteFile, session } = setup({
      session: '# Old Title\n\nbody\n',
      takesPatch: false,
    })

    await placeOldTitleAlias(deps, PATH, RENAME, GENERATION)

    expect(session!.getCalls('flush')).toHaveLength(0)
    expect(noteFile.writes()).toHaveLength(1)
  })

  it('moves a declared frontmatter title on its own, leaving the alias to its own step', async () => {
    const { deps, session } = setup({ session: '---\ntitle: Old Title\n---\n# New Title\n' })

    expect(await moveDeclaredTitle(deps, PATH, RENAME, GENERATION)).toBe(true)
    // Waits for the write to land: links are rewritten to this title next.
    expect(session!.getCalls('commitFrontmatter')).toEqual([[{ title: 'New Title' }]])
    await placeOldTitleAlias(deps, PATH, RENAME, GENERATION)
    expect(session!.getCalls('updateFrontmatter').at(-1)).toEqual([{ aliases: ['Old Title'] }])
  })

  it('moves a declared title on disk, and reports none to move without one', async () => {
    const { deps, noteFile } = setup({ disk: '---\ntitle: Old Title\n---\n# New Title\n' })

    expect(await moveDeclaredTitle(deps, PATH, RENAME, GENERATION)).toBe(true)
    const written = noteFile.getWrites(PATH)[0] ?? ''
    expect(written).toContain('title: New Title')
    expect(written).not.toContain('aliases')

    noteFile.set(PATH, '# New Title\n')
    expect(await moveDeclaredTitle(deps, PATH, RENAME, GENERATION)).toBe(false)
    expect(noteFile.writes()).toHaveLength(1)
  })

  it('fails when an open note cannot persist the title', async () => {
    const { deps, session } = setup({ session: '---\ntitle: Old Title\n---\n# New Title\n' })
    vi.spyOn(session!, 'commitFrontmatter').mockRejectedValue(new Error('disk full'))

    await expect(moveDeclaredTitle(deps, PATH, RENAME, GENERATION)).rejects.toThrow('disk full')
  })

  it('reads the disk while a reopened session is still loading', async () => {
    const { deps, noteFile, session } = setup({
      disk: '---\ntitle: Old Title\n---\n# New Title\n',
      session: null,
    })

    expect(await moveDeclaredTitle(deps, PATH, RENAME, GENERATION)).toBe(true)
    expect(session!.getCalls('commitFrontmatter')).toEqual([])
    expect(noteFile.getWrites(PATH)[0]).toContain('title: New Title')
  })

  it('leaves a title retitled meanwhile alone', async () => {
    // Another edit renamed the note while links were rewritten: it stands.
    const { deps, noteFile } = setup({ disk: '---\ntitle: External\n---\n# External\n' })

    expect(await moveDeclaredTitle(deps, PATH, RENAME, GENERATION)).toBe(false)
    expect(noteFile.writes()).toEqual([])
  })

  it('writes nothing when the alias would be redundant', async () => {
    // A case-only retitle: the old title folds to the new one, so keeping it
    // as an alias would alias a note to its own title.
    const { deps, noteFile, session } = setup({ session: '# new title\n' })

    await placeOldTitleAlias(deps, PATH, { ...RENAME, from: 'new title' }, GENERATION)

    expect(session!.getCalls('updateFrontmatter')).toEqual([])
    expect(session!.getCalls('flush')).toHaveLength(0)
    expect(noteFile.writes()).toEqual([])
  })

  it('returns the aliases it added, for the next rename in the chain to prune', async () => {
    const { deps, session } = setup({
      session: '---\naliases:\n  - Dad\n---\n# Timothy MacCaw\n',
    })

    const added = await placeOldTitleAlias(
      deps,
      PATH,
      { from: 'Tim MacCaw // Dad', to: 'Timothy MacCaw', previousAutoAliases: [] },
      GENERATION,
    )

    expect(added).toEqual(['Tim MacCaw', 'Tim MacCaw // Dad'])
    expect(session!.getCalls('updateFrontmatter')).toEqual([
      [{ aliases: ['Dad', 'Tim MacCaw', 'Tim MacCaw // Dad'] }],
    ])
  })

  it('tracks a segment the previous title still derived once a rename drops it', async () => {
    // First leg: `Alice // Dad` -> `Bob // Dad` added `Alice` and the whole title
    // but not `Dad`, which the new title still derived. Second leg: `Dad` is
    // added for the first time, so it must count as auto-added.
    const { deps, session } = setup({
      session: '---\naliases:\n  - Alice\n  - Alice // Dad\n---\n# Carol\n',
    })

    const added = await placeOldTitleAlias(
      deps,
      PATH,
      { from: 'Bob // Dad', to: 'Carol', previousAutoAliases: ['Alice', 'Alice // Dad'] },
      GENERATION,
    )

    expect(added).toEqual(['Bob', 'Dad', 'Bob // Dad'])
    expect(session!.getCalls('updateFrontmatter')).toEqual([
      [{ aliases: ['Bob', 'Dad', 'Bob // Dad'] }],
    ])
  })

  it('computes against the disk contents, preserving concurrently-gained aliases', async () => {
    const { deps, noteFile } = setup({
      disk: '---\naliases:\n  - Keeper\n---\n# New Title\n',
    })

    await placeOldTitleAlias(deps, PATH, RENAME, GENERATION)

    const written = noteFile.getWrites(PATH).at(-1) ?? ''
    expect(written).toContain('Keeper')
    expect(written).toContain('Old Title')
    expect(written.endsWith('# New Title\n')).toBe(true)
  })

  it('computes against the session buffer, preserving concurrently-gained aliases', async () => {
    const { deps, session } = setup({
      session: '---\naliases:\n  - Gained Elsewhere\n---\n# Old Title\n',
    })

    await placeOldTitleAlias(deps, PATH, RENAME, GENERATION)

    expect(session!.getCalls('updateFrontmatter')).toEqual([
      [{ aliases: ['Gained Elsewhere', 'Old Title'] }],
    ])
  })
})
