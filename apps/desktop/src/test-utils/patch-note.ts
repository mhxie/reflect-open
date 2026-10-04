type Core = typeof import('@reflect/core')

interface NoteCommands {
  readNote: Core['readNote']
  writeNote: Core['writeNote']
}

/**
 * Core's `patchNote`, re-bound to a test's mocked `readNote` / `writeNote`. A
 * test that swaps those two on `@reflect/core` must swap `patchNote` too: the
 * real one calls core's own command module, which a package-level mock never
 * reaches. Pass `core` from the mock factory's `importOriginal`, and import
 * this module inside the factory, so it never loads `@reflect/core` itself:
 *
 *     vi.mock('@reflect/core', async (importOriginal) => {
 *       const core = await importOriginal<typeof import('@reflect/core')>()
 *       const { patchNoteOver } = await import('@/test-utils/patch-note.ts')
 *       return { ...core, readNote, writeNote, patchNote: patchNoteOver(core, { readNote, writeNote }) }
 *     })
 */
export function patchNoteOver(core: Core, commands: NoteCommands): Core['patchNote'] {
  return async (path, patch, generation, options) =>
    await core.patchNoteWith(
      {
        read: async (notePath) => {
          try {
            return await commands.readNote(notePath, generation)
          } catch (cause) {
            if (core.isAppError(cause) && cause.kind === 'notFound') {
              return null
            }
            throw cause
          }
        },
        write: (notePath, contents, expectedContents) =>
          commands.writeNote(notePath, contents, generation, expectedContents),
      },
      path,
      patch,
      options,
    )
}
