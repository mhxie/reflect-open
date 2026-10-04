import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoteSession } from '@/editor/note-session.ts'

const readNote = vi.hoisted(() => vi.fn<(path: string) => Promise<string>>())
const writeNote = vi.hoisted(() => vi.fn(async () => {}))
const CHANGED_ON_DISK = { kind: 'io', message: 'Note changed on disk; reload before retrying' }
const openSession = vi.hoisted(() => vi.fn<(path: string) => NoteSession | null>(() => null))

vi.mock('@reflect/core', async (importOriginal) => {
  const core = await importOriginal<typeof import('@reflect/core')>()
  const { patchNoteOver } = await import('@/test-utils/patch-note.ts')
  return {
    ...core,
    readNote,
    writeNote,
    patchNote: patchNoteOver(core, { readNote, writeNote }),
  }
})
vi.mock('@/editor/open-documents.ts', () => ({ openSession }))

const { commitNoteFrontmatter, readNoteSource } = await import('./note-frontmatter.ts')

function fakeSession(options: { live?: string | null; canCommit?: boolean }) {
  const commitFrontmatter = vi.fn(async () => options.canCommit ?? true)
  const session = {
    liveContent: () => options.live ?? null,
    commitFrontmatter,
  } as unknown as NoteSession
  return { session, commitFrontmatter }
}

beforeEach(() => {
  readNote.mockReset()
  writeNote.mockReset().mockResolvedValue(undefined)
  openSession.mockReset().mockReturnValue(null)
})

describe('readNoteSource', () => {
  it("reads the open session's loaded buffer, not disk", async () => {
    openSession.mockReturnValue(fakeSession({ live: '# live\n' }).session)
    await expect(readNoteSource('notes/a.md')).resolves.toBe('# live\n')
    expect(readNote).not.toHaveBeenCalled()
  })

  it('falls back to disk while the session is still loading (liveContent null)', async () => {
    openSession.mockReturnValue(fakeSession({ live: null }).session)
    readNote.mockResolvedValue('# disk\n')
    await expect(readNoteSource('notes/a.md')).resolves.toBe('# disk\n')
  })

  it('reads disk when no session is open', async () => {
    readNote.mockResolvedValue('# disk\n')
    await expect(readNoteSource('notes/a.md')).resolves.toBe('# disk\n')
  })
})

describe('commitNoteFrontmatter', () => {
  it('lands the patch through the live session when it can take it', async () => {
    const { session, commitFrontmatter } = fakeSession({ live: '# A\n', canCommit: true })
    openSession.mockReturnValue(session)

    await commitNoteFrontmatter('notes/a.md', { pinned: true }, 3)

    expect(commitFrontmatter).toHaveBeenCalledWith({ pinned: true })
    expect(writeNote).not.toHaveBeenCalled()
  })

  it('falls back to a disk patch when the session declines the patch', async () => {
    openSession.mockReturnValue(fakeSession({ live: '# A\n', canCommit: false }).session)
    readNote.mockResolvedValue('# A\n')

    await commitNoteFrontmatter('notes/a.md', { pinned: true }, 3)

    expect(writeNote).toHaveBeenCalledWith(
      'notes/a.md',
      '---\npinned: true\n---\n\n# A\n',
      3,
      '# A\n',
    )
  })

  it('patches disk directly when no session is open', async () => {
    readNote.mockResolvedValue('# A\n')

    await commitNoteFrontmatter('notes/a.md', { private: true }, 3)

    expect(writeNote).toHaveBeenCalledWith(
      'notes/a.md',
      '---\nprivate: true\n---\n\n# A\n',
      3,
      '# A\n',
    )
  })

  it('writes nothing when the patch changes nothing', async () => {
    readNote.mockResolvedValue('---\npinned: true\n---\n\n# A\n')

    await commitNoteFrontmatter('notes/a.md', { pinned: true }, 3)

    expect(writeNote).not.toHaveBeenCalled()
  })

  it('re-applies the patch to a concurrent change instead of clobbering it', async () => {
    readNote.mockResolvedValueOnce('# A\n').mockResolvedValue('# A\n\nfrom the phone\n')
    writeNote.mockRejectedValueOnce(CHANGED_ON_DISK)

    await commitNoteFrontmatter('notes/a.md', { pinned: true }, 3)

    expect(writeNote).toHaveBeenCalledTimes(2)
    expect(writeNote).toHaveBeenLastCalledWith(
      'notes/a.md',
      '---\npinned: true\n---\n\n# A\n\nfrom the phone\n',
      3,
      '# A\n\nfrom the phone\n',
    )
  })

  it('surfaces the conflict after three refused writes', async () => {
    let version = 0
    readNote.mockImplementation(async () => `# A\n\nv${version++}\n`)
    writeNote.mockRejectedValue(CHANGED_ON_DISK)

    await expect(commitNoteFrontmatter('notes/a.md', { pinned: true }, 3)).rejects.toMatchObject(
      CHANGED_ON_DISK,
    )
    expect(writeNote).toHaveBeenCalledTimes(3)
  })

  it('never writes the frontmatter-only stub over a file that appeared after its read', async () => {
    readNote
      .mockRejectedValueOnce({ kind: 'notFound', message: 'no such note' })
      .mockResolvedValue('# Appeared\n')
    writeNote.mockRejectedValueOnce(CHANGED_ON_DISK)

    await commitNoteFrontmatter('daily/2026-06-10.md', { pinned: true }, 3)

    // The stub was only ever offered as a create (expected: absent), which
    // Rust refuses once a file exists; the landed write patches that file.
    expect(writeNote).toHaveBeenNthCalledWith(
      1,
      'daily/2026-06-10.md',
      '---\npinned: true\n---\n\n',
      3,
      null,
    )
    expect(writeNote).toHaveBeenLastCalledWith(
      'daily/2026-06-10.md',
      '---\npinned: true\n---\n\n# Appeared\n',
      3,
      '# Appeared\n',
    )
  })
})
