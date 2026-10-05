import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { queryKeys } from '@/lib/query-client.ts'

const readNote = vi.hoisted(() => vi.fn<(path: string) => Promise<string>>())
const writeNote = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('@reflect/core', async (importOriginal) => {
  const core = await importOriginal<typeof import('@reflect/core')>()
  return {
    ...core,
    readNote,
    writeNote,
    isLocalOnlyReadOnlyPath: (path: string) => path.startsWith('finance/secure/'),
  }
})
vi.mock('@/editor/open-documents.ts', () => ({ openSession: () => null }))
const operationFail = vi.hoisted(() => vi.fn())
vi.mock('@/lib/operations.ts', () => ({ startOperation: () => ({ fail: operationFail }) }))

const { toggleNotePinned, unpinNote } = await import('./note-pin.ts')

describe('pinning a note in a read-only local-only folder', () => {
  it('changes nothing: no optimistic pin, no read, no write, no error', async () => {
    const client = new QueryClient()
    const input = { queryClient: client, root: '/g', generation: 3, path: 'finance/secure/a.md' }

    await toggleNotePinned(input)
    await unpinNote(input)

    expect(client.getQueryData(queryKeys.index.pinnedNotes('/g'))).toBeUndefined()
    expect(readNote).not.toHaveBeenCalled()
    expect(writeNote).not.toHaveBeenCalled()
    expect(operationFail).not.toHaveBeenCalled()
  })
})
