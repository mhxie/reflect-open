import { afterEach, describe, expect, it, vi } from 'vitest'
import { isAppError } from '../errors.ts'
import { setBridge } from '../ipc/bridge.ts'
import { CHANGED_ON_DISK, fakeNoteStore, type FakeNoteStore } from '../testing/fake-note-store.ts'
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
    read: async (path) => store.files.get(path) ?? null,
    write: (path, contents, expectedContents) =>
      store.writeNote(path, contents, 1, expectedContents),
  }
}

/** A patch that appends `line` to the note, creating it when missing. */
function appendLine(line: string): (source: string | null) => string {
  return (source) => `${source ?? ''}${line}\n`
}

afterEach(() => {
  setBridge(null)
})

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
      store.files.set(PATH, '# Plan\n- step\n')
    }
    const once = (source: string | null): string | null =>
      source?.includes('- step') === true ? null : appendLine('- step')(source)

    const result = await patchNoteWith(storeIo(store), PATH, once)

    expect(result).toEqual({ source: '# Plan\n- step\n', patched: null, written: false })
    expect(store.files.get(PATH)).toBe('# Plan\n- step\n')
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

  it('surfaces a real write failure at once when the file did not change', async () => {
    const diskFull = { kind: 'io', message: 'disk full' }
    const io: NotePatchIo = {
      read: async () => '# Plan\n',
      write: vi.fn(async () => {
        throw diskFull
      }),
    }

    await expect(patchNoteWith(io, PATH, appendLine('- step'))).rejects.toBe(diskFull)
    expect(io.write).toHaveBeenCalledTimes(1)
  })

  it('surfaces the refusal when the note cannot be re-read', async () => {
    const graphSwitched = { kind: 'io', message: 'the graph changed since this command was issued' }
    const read = vi
      .fn<NotePatchIo['read']>()
      .mockResolvedValueOnce('# Plan\n')
      .mockRejectedValue({ kind: 'noGraph', message: 'No graph is open' })
    const io: NotePatchIo = {
      read,
      write: async () => {
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
    const invoke = vi.fn(async (command: string, args: Record<string, unknown>) => {
      if (command === 'note_read') {
        const contents = files.get(String(args['path']))
        if (contents === undefined) throw { kind: 'notFound', message: 'missing' }
        return contents
      }
      if (command === 'note_write') {
        files.set(String(args['path']), String(args['contents']))
        return 1_234
      }
      throw new Error(`unexpected command ${command}`)
    })
    setBridge({ invoke, listen: async () => () => {} })

    await patchNote(PATH, appendLine('- step'), 7)
    await patchNote('notes/new.md', appendLine('- first'), 7)

    expect(invoke).toHaveBeenCalledWith('note_read', { path: PATH, generation: 7 })
    expect(invoke).toHaveBeenCalledWith('note_write', {
      path: PATH,
      contents: '# Plan\n- step\n',
      generation: 7,
      checkContents: true,
      expectedContents: '# Plan\n',
    })
    expect(invoke).toHaveBeenCalledWith('note_write', {
      path: 'notes/new.md',
      contents: '- first\n',
      generation: 7,
      checkContents: true,
      expectedContents: null,
    })
  })
})
