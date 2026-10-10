import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * IO-bound core functions are mocked; the pure helpers (`parseNote`,
 * `nextAliases`, `upsertFrontmatter`) stay real so the alias math is
 * exercised, not restated — the same split as the coordinator tests.
 */
const io = vi.hoisted(() => ({
  readNote: vi.fn(),
  writeNote: vi.fn(),
}))
vi.mock('@reflect/core', async (importOriginal) => {
  const core = await importOriginal<typeof import('@reflect/core')>()
  const { patchNoteOver } = await import('@/test-utils/patch-note.ts')
  return {
    ...core,
    readNote: io.readNote,
    writeNote: io.writeNote,
    patchNote: patchNoteOver(core, { readNote: io.readNote, writeNote: io.writeNote }),
  }
})

const docs = vi.hoisted(() => ({ openSession: vi.fn() }))
vi.mock('./open-documents', () => ({
  openSession: docs.openSession,
}))

const { moveDeclaredTitle, placeOldTitleAlias } = await import('./alias-placement.ts')

const PATH = 'notes/subject.md'
const RENAME = { from: 'Old Title', to: 'New Title', previousAutoAliases: [] }
const CHANGED_ON_DISK = { kind: 'io', message: 'Note changed on disk; reload before retrying' }

beforeEach(() => {
  io.readNote.mockReset()
  io.writeNote.mockReset().mockResolvedValue(undefined)
  docs.openSession.mockReset().mockReturnValue(null)
})

function fakeSession(options?: { content?: string | null; takesPatch?: boolean }) {
  const content = options?.content === undefined ? '# Old Title\n\nbody\n' : options.content
  return {
    content: () => content ?? '',
    liveContent: () => content,
    updateFrontmatter: vi.fn().mockReturnValue(options?.takesPatch ?? true),
    commitFrontmatter: vi.fn().mockResolvedValue(options?.takesPatch ?? true),
    flush: vi.fn().mockResolvedValue(undefined),
  }
}

describe('placeOldTitleAlias', () => {
  it('refuses to put an old private title into another graph’s same-path live session', async () => {
    const otherSession = fakeSession({ content: '# Public note\n' })
    docs.openSession.mockImplementation((_path: string, generation: number) =>
      generation === 8 ? otherSession : null,
    )
    io.readNote.mockRejectedValue(new Error('stale graph'))
    await expect(
      placeOldTitleAlias(PATH, { ...RENAME, from: 'Private account title' }, 7),
    ).rejects.toThrow('stale graph')
    expect(docs.openSession).toHaveBeenCalledWith(PATH, 7)
    expect(otherSession.updateFrontmatter).not.toHaveBeenCalled()
    expect(otherSession.flush).not.toHaveBeenCalled()
    expect(io.writeNote).not.toHaveBeenCalled()
  })

  it('with no live session, patches the alias straight onto disk at the generation', async () => {
    io.readNote.mockResolvedValue('# Old Title\n\nbody\n')

    await placeOldTitleAlias(PATH, RENAME, 7)

    expect(io.writeNote).toHaveBeenCalledTimes(1)
    const [path, content, generation] = io.writeNote.mock.calls[0]!
    expect(path).toBe(PATH)
    expect(content).toContain('aliases:')
    expect(content).toContain('Old Title')
    expect(content).toContain('# Old Title\n\nbody\n') // body untouched
    expect(generation).toBe(7)
    // Checked against the text the aliases were computed from.
    expect(io.writeNote.mock.calls[0]![3]).toBe('# Old Title\n\nbody\n')
  })

  it('recomputes the aliases over a concurrent change instead of clobbering it', async () => {
    const gained = '---\naliases:\n  - Gained Elsewhere\n---\n# Old Title\n\nbody\n'
    io.readNote.mockResolvedValueOnce('# Old Title\n\nbody\n').mockResolvedValue(gained)
    io.writeNote.mockRejectedValueOnce(CHANGED_ON_DISK)

    const added = await placeOldTitleAlias(PATH, RENAME, 7)

    expect(added).toEqual(['Old Title'])
    expect(io.writeNote).toHaveBeenCalledTimes(2)
    const [, content, , expected] = io.writeNote.mock.calls[1]!
    expect(content).toContain('Gained Elsewhere')
    expect(content).toContain('Old Title')
    expect(expected).toBe(gained)
  })

  it('surfaces the conflict after three refused writes', async () => {
    let version = 0
    io.readNote.mockImplementation(async () => `# Old Title\n\nv${version++}\n`)
    io.writeNote.mockRejectedValue(CHANGED_ON_DISK)

    await expect(placeOldTitleAlias(PATH, RENAME, 7)).rejects.toMatchObject(CHANGED_ON_DISK)
    expect(io.writeNote).toHaveBeenCalledTimes(3)
  })

  it('routes through a live session: frontmatter channel, then flush, no disk write', async () => {
    const session = fakeSession()
    docs.openSession.mockReturnValue(session)

    await placeOldTitleAlias(PATH, RENAME, 7)

    expect(session.updateFrontmatter).toHaveBeenCalledWith({ aliases: ['Old Title'] })
    expect(session.flush).toHaveBeenCalledTimes(1)
    expect(io.readNote).not.toHaveBeenCalled()
    expect(io.writeNote).not.toHaveBeenCalled()
  })

  it('falls back to disk when the session cannot take the patch', async () => {
    const session = fakeSession({ takesPatch: false })
    docs.openSession.mockReturnValue(session)
    io.readNote.mockResolvedValue('# Old Title\n\nbody\n')

    await placeOldTitleAlias(PATH, RENAME, 7)

    expect(session.flush).not.toHaveBeenCalled()
    expect(io.writeNote).toHaveBeenCalledTimes(1)
  })

  it('moves a declared frontmatter title on its own, leaving the alias to its own step', async () => {
    const session = fakeSession({ content: '---\ntitle: Old Title\n---\n# New Title\n' })
    docs.openSession.mockReturnValue(session)

    expect(await moveDeclaredTitle(PATH, RENAME, 7)).toBe(true)
    // Waits for the write to land: links are rewritten to this title next.
    expect(session.commitFrontmatter).toHaveBeenCalledWith({ title: 'New Title' })
    await placeOldTitleAlias(PATH, RENAME, 7)
    expect(session.updateFrontmatter).toHaveBeenLastCalledWith({ aliases: ['Old Title'] })
  })

  it('moves a declared title on disk, and reports none to move without one', async () => {
    io.readNote.mockResolvedValue('---\ntitle: Old Title\n---\n# New Title\n')
    expect(await moveDeclaredTitle(PATH, RENAME, 7)).toBe(true)
    const written = io.writeNote.mock.calls[0]?.[1] as string
    expect(written).toContain('title: New Title')
    expect(written).not.toContain('aliases')

    io.writeNote.mockClear()
    io.readNote.mockResolvedValue('# New Title\n')
    expect(await moveDeclaredTitle(PATH, RENAME, 7)).toBe(false)
    expect(io.writeNote).not.toHaveBeenCalled()
  })

  it('fails when an open note cannot persist the title', async () => {
    const session = fakeSession({ content: '---\ntitle: Old Title\n---\n# New Title\n' })
    session.commitFrontmatter.mockRejectedValue(new Error('disk full'))
    docs.openSession.mockReturnValue(session)
    await expect(moveDeclaredTitle(PATH, RENAME, 7)).rejects.toThrow('disk full')
  })

  it('reads the disk while a reopened session is still loading', async () => {
    const session = fakeSession({ content: null })
    docs.openSession.mockReturnValue(session)
    io.readNote.mockResolvedValue('---\ntitle: Old Title\n---\n# New Title\n')
    expect(await moveDeclaredTitle(PATH, RENAME, 7)).toBe(true)
    expect(io.writeNote.mock.calls[0]?.[1]).toContain('title: New Title')
  })

  it('leaves a title retitled meanwhile alone', async () => {
    // Another edit renamed the note while links were rewritten: it stands.
    io.readNote.mockResolvedValue('---\ntitle: External\n---\n# External\n')
    expect(await moveDeclaredTitle(PATH, RENAME, 7)).toBe(false)
    expect(io.writeNote).not.toHaveBeenCalled()
  })

  it('writes nothing when the alias would be redundant', async () => {
    // A case-only retitle: the old title folds to the new one, so keeping it
    // as an alias would alias a note to its own title.
    const session = fakeSession({ content: '# new title\n' })
    docs.openSession.mockReturnValue(session)

    await placeOldTitleAlias(PATH, { ...RENAME, from: 'new title' }, 7)

    expect(session.updateFrontmatter).not.toHaveBeenCalled()
    expect(session.flush).not.toHaveBeenCalled()
    expect(io.writeNote).not.toHaveBeenCalled()
  })

  it('returns the aliases it added, for the next rename in the chain to prune', async () => {
    const session = fakeSession({ content: '---\naliases:\n  - Dad\n---\n# Timothy MacCaw\n' })
    docs.openSession.mockReturnValue(session)

    const added = await placeOldTitleAlias(
      PATH,
      { from: 'Tim MacCaw // Dad', to: 'Timothy MacCaw', previousAutoAliases: [] },
      7,
    )

    expect(added).toEqual(['Tim MacCaw', 'Tim MacCaw // Dad'])
    expect(session.updateFrontmatter).toHaveBeenCalledWith({
      aliases: ['Dad', 'Tim MacCaw', 'Tim MacCaw // Dad'],
    })
  })

  it('tracks a segment the previous title still derived once a rename drops it', async () => {
    // First leg: `Alice // Dad` -> `Bob // Dad` added `Alice` and the whole title
    // but not `Dad`, which the new title still derived. Second leg: `Dad` is
    // added for the first time, so it must count as auto-added.
    const session = fakeSession({
      content: '---\naliases:\n  - Alice\n  - Alice // Dad\n---\n# Carol\n',
    })
    docs.openSession.mockReturnValue(session)

    const added = await placeOldTitleAlias(
      PATH,
      { from: 'Bob // Dad', to: 'Carol', previousAutoAliases: ['Alice', 'Alice // Dad'] },
      7,
    )

    expect(added).toEqual(['Bob', 'Dad', 'Bob // Dad'])
    expect(session.updateFrontmatter).toHaveBeenCalledWith({
      aliases: ['Bob', 'Dad', 'Bob // Dad'],
    })
  })

  it('computes against the session buffer, preserving concurrently-gained aliases', async () => {
    const session = fakeSession({
      content: '---\naliases:\n  - Gained Elsewhere\n---\n# Old Title\n',
    })
    docs.openSession.mockReturnValue(session)

    await placeOldTitleAlias(PATH, RENAME, 7)

    expect(session.updateFrontmatter).toHaveBeenCalledWith({
      aliases: ['Gained Elsewhere', 'Old Title'],
    })
  })
})
