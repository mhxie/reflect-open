import { afterEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '../ipc/bridge.ts'
import { createAsset, importAsset } from './assets.ts'

afterEach(() => {
  setBridge(null)
})

function bytesOf(size: number, fill: number): Blob {
  return new Blob([new Uint8Array(size).fill(fill)])
}

describe('createAsset', () => {
  it('streams begin → chunked appends → commit and returns the final path', async () => {
    const invoke = vi.fn(async (command: string) =>
      command === 'asset_upload_begin'
        ? 'upload-1'
        : command === 'asset_upload_commit'
          ? 'assets/report.pdf'
          : null,
    )
    const invokeBinary = vi.fn(
      async (_command: string, _body: Uint8Array, _headers: Record<string, string>) => null,
    )
    setBridge({ invoke, invokeBinary, listen: async () => () => {} })

    // 5 MiB: crosses the 4 MiB chunk size, so exactly two appends.
    const path = await createAsset('report.pdf', bytesOf(5 * 1024 * 1024, 7), 'notes/q3.md', 3)

    expect(path).toBe('assets/report.pdf')
    expect(invoke).toHaveBeenCalledWith('asset_upload_begin', { generation: 3 })
    expect(invokeBinary).toHaveBeenCalledTimes(2)
    const [command, firstChunk, headers] = invokeBinary.mock.calls[0]!
    expect(command).toBe('asset_upload_append')
    expect(firstChunk.byteLength).toBe(4 * 1024 * 1024)
    expect(headers).toEqual({ 'x-upload-id': 'upload-1' })
    expect(invoke).toHaveBeenCalledWith('asset_upload_commit', {
      id: 'upload-1',
      desiredName: 'report.pdf',
      notePath: 'notes/q3.md',
      generation: 3,
    })
  })

  it('names the note, so Rust can keep a local-only note’s attachment in its folder', async () => {
    const invoke = vi.fn(async (command: string) =>
      command === 'asset_upload_begin'
        ? 'upload-3'
        : command === 'asset_upload_commit'
          ? 'finance/secure/assets/scan.png'
          : null,
    )
    const invokeBinary = vi.fn(async () => null)
    setBridge({ invoke, invokeBinary, listen: async () => () => {} })

    const path = await createAsset('scan.png', bytesOf(8, 1), 'finance/secure/bank.md', 4)

    expect(path).toBe('finance/secure/assets/scan.png')
    expect(invoke).toHaveBeenCalledWith('asset_upload_commit', {
      id: 'upload-3',
      desiredName: 'scan.png',
      notePath: 'finance/secure/bank.md',
      generation: 4,
    })
  })

  it('aborts the upload and rethrows when an append fails', async () => {
    const invoke = vi.fn(async (command: string) =>
      command === 'asset_upload_begin' ? 'upload-9' : null,
    )
    const invokeBinary = vi.fn(async () => {
      throw { kind: 'io', message: 'disk full' }
    })
    setBridge({ invoke, invokeBinary, listen: async () => () => {} })

    await expect(createAsset('big.zip', bytesOf(16, 1), 'notes/a.md', 2)).rejects.toMatchObject({
      kind: 'io',
      message: 'disk full',
    })
    expect(invoke).toHaveBeenCalledWith('asset_upload_abort', { id: 'upload-9' })
    expect(invoke).not.toHaveBeenCalledWith('asset_upload_commit', expect.anything())
  })

  it('fails loudly when the bridge has no binary transport', async () => {
    const invoke = vi.fn(async (command: string) =>
      command === 'asset_upload_begin' ? 'upload-2' : null,
    )
    setBridge({ invoke, listen: async () => () => {} })

    await expect(createAsset('a.pdf', bytesOf(8, 0), 'notes/a.md', 1)).rejects.toMatchObject({
      kind: 'io',
    })
    expect(invoke).toHaveBeenCalledWith('asset_upload_abort', { id: 'upload-2' })
  })
})

describe('importAsset', () => {
  it('copies by OS path through the generation-pinned command', async () => {
    const invoke = vi.fn(async () => 'assets/q3-report-2.pdf')
    setBridge({ invoke, listen: async () => () => {} })

    const path = await importAsset(
      '/Users/me/Downloads/Q3 report.pdf',
      'q3-report.pdf',
      'notes/q3.md',
      5,
    )

    expect(path).toBe('assets/q3-report-2.pdf')
    expect(invoke).toHaveBeenCalledWith('asset_import', {
      sourcePath: '/Users/me/Downloads/Q3 report.pdf',
      desiredName: 'q3-report.pdf',
      notePath: 'notes/q3.md',
      generation: 5,
    })
  })
})
