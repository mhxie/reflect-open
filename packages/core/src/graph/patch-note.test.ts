import { describe, expect, it, vi } from 'vitest'
import { AppError, isAppError } from '../errors.ts'
import { CHANGED_ON_DISK, fakeNoteStore, type FakeNoteStore } from '../testing/fake-note-store.ts'
import {
  createTestClockService,
  createTestFileChangeService,
  createTestIpcBridgeService,
  createTestNoteFileService,
  overrideNoteFileService,
} from '../testing/index.ts'
import { createNoteFileService } from './note-file-service.ts'
import {
  NoteChangedError,
  PATCH_NOTE_ATTEMPTS,
  isNoteChangedError,
  patchNote,
  patchNoteWith,
  type NotePatchIo,
} from './patch-note.ts'

const PATH = 'notes/plan.md'

/** The store as a patch's IO, with a missing note read as `null`. */
function storeIo(store: FakeNoteStore): NotePatchIo {
  return {
    read: (path) => store.files.get(path) ?? null,
    write: (path, contents, expectedContents) => {
      return store.writeNote(path, contents, 1, expectedContents)
    },
  }
}

/** A patch that appends `line` to the note, creating it when missing. */
function appendLine(line: string): (source: string | null) => string {
  return (source) => `${source ?? ''}${line}\n`
}

describe('patchNoteWith', () => {
  it('writes the patched source checked against the bytes the patch saw', async () => {
    const store = fakeNoteStore({ [PATH]: '# Plan\n' })
    const write = vi.spyOn(store, 'writeNote')

    const result = await patchNoteWith(storeIo(store), PATH, appendLine('- step'))

    expect(result).toEqual({ source: '# Plan\n', patched: '# Plan\n- step\n', written: true })
    expect(write).toHaveBeenCalledWith(PATH, '# Plan\n- step\n', 1, '# Plan\n')
    expect(store.files.get(PATH)).toBe('# Plan\n- step\n')
  })

  it('hands a missing note to the patch as null and writes it as must-not-exist', async () => {
    const store = fakeNoteStore()
    const write = vi.spyOn(store, 'writeNote')

    await patchNoteWith(storeIo(store), PATH, appendLine('- first'))

    expect(write).toHaveBeenCalledWith(PATH, '- first\n', 1, null)
    expect(store.files.get(PATH)).toBe('- first\n')
  })

  it('writes nothing when the patch declines or changes nothing', async () => {
    const store = fakeNoteStore({ [PATH]: '# Plan\n' })

    await expect(patchNoteWith(storeIo(store), PATH, () => null)).resolves.toEqual({
      source: '# Plan\n',
      patched: null,
      written: false,
    })
    await expect(patchNoteWith(storeIo(store), PATH, (source) => source)).resolves.toEqual({
      source: '# Plan\n',
      patched: '# Plan\n',
      written: false,
    })
    expect(store.landed).toEqual([])
  })

  it('re-applies the patch to a concurrent change instead of clobbering it', async () => {
    const store = fakeNoteStore({ [PATH]: '# Plan\n' })
    const seen: Array<string | null> = []
    let raced = false
    store.beforeWrite = () => {
      if (!raced) {
        raced = true
        store.files.set(PATH, '# Plan\n- from the phone\n')
      }
    }

    const result = await patchNoteWith(storeIo(store), PATH, (source) => {
      seen.push(source)
      return appendLine('- step')(source)
    })

    expect(seen).toEqual(['# Plan\n', '# Plan\n- from the phone\n'])
    expect(result).toMatchObject({ patched: '# Plan\n- from the phone\n- step\n', written: true })
    expect(store.files.get(PATH)).toBe('# Plan\n- from the phone\n- step\n')
    expect(store.refused).toBe(1)
  })

  it('stops once a re-applied patch finds nothing left to do', async () => {
    const store = fakeNoteStore({ [PATH]: '# Plan\n' })
    store.beforeWrite = () => {
      store.files.set(PATH, '# Plan\n- step\n- from the phone\n')
    }
    const once = (source: string | null): string | null => {
      return source?.includes('- step') === true ? null : appendLine('- step')(source)
    }

    const result = await patchNoteWith(storeIo(store), PATH, once)

    expect(result).toEqual({
      source: '# Plan\n- step\n- from the phone\n',
      patched: null,
      written: false,
    })
    expect(store.files.get(PATH)).toBe('# Plan\n- step\n- from the phone\n')
  })

  it(`surfaces the conflict after ${PATCH_NOTE_ATTEMPTS} refused writes`, async () => {
    const store = fakeNoteStore({ [PATH]: 'v0\n' })
    let version = 0
    store.beforeWrite = () => {
      version += 1
      store.files.set(PATH, `v${version}\n`)
    }

    const failure = await patchNoteWith(storeIo(store), PATH, appendLine('- step')).catch(
      (cause: unknown) => cause,
    )

    expect(failure).toBeInstanceOf(NoteChangedError)
    expect(isNoteChangedError(failure)).toBe(true)
    expect(isAppError(failure)).toBe(true)
    expect(failure).toMatchObject({ ...CHANGED_ON_DISK, path: PATH, cause: CHANGED_ON_DISK })
    expect(store.refused).toBe(PATCH_NOTE_ATTEMPTS)
    // The last concurrent change is still on disk, never overwritten.
    expect(store.files.get(PATH)).toBe(`v${PATCH_NOTE_ATTEMPTS}\n`)
  })

  it('honors a smaller attempt budget', async () => {
    const store = fakeNoteStore({ [PATH]: 'v0\n' })
    let version = 0
    store.beforeWrite = () => {
      version += 1
      store.files.set(PATH, `v${version}\n`)
    }

    await expect(
      patchNoteWith(storeIo(store), PATH, appendLine('- step'), { attempts: 2 }),
    ).rejects.toBeInstanceOf(NoteChangedError)
    expect(store.refused).toBe(2)
  })

  it('counts a concurrent writer that produced the same text as written', async () => {
    const store = fakeNoteStore({ [PATH]: '# Plan\n' })
    store.beforeWrite = () => {
      store.files.set(PATH, '# Plan\n- step\n')
    }
    const patch = vi.fn(appendLine('- step'))

    const result = await patchNoteWith(storeIo(store), PATH, patch)

    expect(result).toEqual({ source: '# Plan\n', patched: '# Plan\n- step\n', written: true })
    expect(patch).toHaveBeenCalledTimes(1)
    expect(store.files.get(PATH)).toBe('# Plan\n- step\n')
  })

  it('surfaces a real write failure at once when the file did not change', async () => {
    const diskFull = new AppError('io', 'disk full')
    const io: NotePatchIo = {
      read: () => '# Plan\n',
      write: vi.fn(() => {
        throw diskFull
      }),
    }

    await expect(patchNoteWith(io, PATH, appendLine('- step'))).rejects.toBe(diskFull)
    expect(io.write).toHaveBeenCalledTimes(1)
  })

  it('surfaces the refusal when the note cannot be re-read', async () => {
    const graphSwitched = new AppError('io', 'the graph changed since this command was issued')
    const read = vi
      .fn<NotePatchIo['read']>()
      .mockResolvedValueOnce('# Plan\n')
      .mockRejectedValue(new AppError('noGraph', 'No graph is open'))
    const io: NotePatchIo = {
      read,
      write: () => {
        throw graphSwitched
      },
    }

    await expect(patchNoteWith(io, PATH, appendLine('- step'))).rejects.toBe(graphSwitched)
  })

  it('aborts with nothing written when the patch throws', async () => {
    const store = fakeNoteStore({ [PATH]: '# Plan\n' })

    await expect(
      patchNoteWith(storeIo(store), PATH, () => {
        throw new Error('task is gone')
      }),
    ).rejects.toThrow('task is gone')
    expect(store.landed).toEqual([])
  })
})

describe('patchNote', () => {
  it('pins the read and the checked write to the generation', async () => {
    const files = new Map([[PATH, '# Plan\n']])
    const ipc = createTestIpcBridgeService({
      commands: {
        note_read: (args) => {
          const contents = files.get(String(args['path']))
          if (contents === undefined) throw new AppError('notFound', 'missing')
          return contents
        },
        note_write: (args) => {
          files.set(String(args['path']), String(args['contents']))
          return 1_234
        },
      },
    })
    const noteFile = createNoteFileService({
      ipc,
      clock: createTestClockService(),
      fileChanges: createTestFileChangeService(),
    })

    await patchNote(noteFile, PATH, appendLine('- step'), 7)
    await patchNote(noteFile, 'notes/new.md', appendLine('- first'), 7)

    expect(ipc.calls()).toContainEqual({
      command: 'note_read',
      args: { path: PATH, generation: 7 },
    })
    expect(ipc.calls()).toContainEqual({
      command: 'note_write',
      args: {
        path: PATH,
        contents: '# Plan\n- step\n',
        generation: 7,
        checkContents: true,
        expectedContents: '# Plan\n',
      },
    })
    expect(ipc.calls()).toContainEqual({
      command: 'note_write',
      args: {
        path: 'notes/new.md',
        contents: '- first\n',
        generation: 7,
        checkContents: true,
        expectedContents: null,
      },
    })
  })

  it('never applies a patch twice when its write fails only after landing', async () => {
    const inner = createTestNoteFileService({ files: { [PATH]: '# Plan\n' } })
    // A write whose bytes are already on disk can still reject: a change
    // listener that throws after the write landed.
    const noteFile = overrideNoteFileService(inner, {
      write: async (path, contents, generation, expectedContents) => {
        await inner.write(path, contents, generation, expectedContents)
        throw new Error('listener failed')
      },
    })

    const result = await patchNote(noteFile, PATH, appendLine('- step'), 7)

    expect(result).toEqual({ source: '# Plan\n', patched: '# Plan\n- step\n', written: true })
    expect(inner.getWrites(PATH)).toEqual(['# Plan\n- step\n'])
    expect(inner.files().get(PATH)).toBe('# Plan\n- step\n')
  })
})
