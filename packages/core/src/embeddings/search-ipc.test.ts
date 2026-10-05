import { afterEach, describe, expect, it } from 'vitest'
import { setBridge } from '../ipc/bridge.ts'
import { answerSearchIpcRequest } from './search-ipc.ts'

/**
 * A bridge with a ready (or absent) model whose index holds one public note
 * and two restricted ones, which rank first when `privateFirst` is set.
 */
function fakeApp(options: { ready: boolean; privateFirst?: boolean }): Array<[string, unknown]> {
  const calls: Array<[string, unknown]> = []
  setBridge({
    invoke: async (command, args) => {
      calls.push([command, args])
      if (command === 'embed_status') {
        return options.ready
          ? { status: 'ready', model: 'all-MiniLM-L6-v2', dims: 384 }
          : { status: 'uninitialized' }
      }
      if (command === 'embed_texts') {
        return [[0.1, 0.2]]
      }
      const sql = String(args['sql'] ?? '')
      if (sql.includes('materialized')) {
        const rows = [
          {
            path: 'notes/public.md',
            is_private: 0,
            has_device_only_content: 0,
            title: 'Public',
            daily_date: null,
            preview: '',
            mtime: 1,
            is_pinned: 0,
            fts_highlighted_title: 'Public',
            snippet: 'a \u{1}wombat\u{2} note',
          },
          {
            path: 'notes/secret.md',
            is_private: 1,
            has_device_only_content: 0,
            title: 'Secret',
            daily_date: null,
            preview: '',
            mtime: 1,
            is_pinned: 0,
            fts_highlighted_title: 'Secret',
            snippet: 'secret wombat',
          },
          {
            path: 'notes/ocr.md',
            is_private: 0,
            has_device_only_content: 1,
            title: 'OCR sentinel',
            daily_date: null,
            preview: '',
            mtime: 1,
            is_pinned: 0,
            fts_highlighted_title: 'OCR sentinel',
            snippet: 'private OCR wombat',
          },
        ]
        return options.privateFirst === true ? [rows[1], rows[0], rows[2]] : rows
      }
      if (sql.includes('"is_private"')) {
        return [
          { path: 'notes/public.md', is_private: 0, has_device_only_content: 0 },
          { path: 'notes/secret.md', is_private: 1, has_device_only_content: 0 },
          { path: 'notes/ocr.md', is_private: 0, has_device_only_content: 1 },
        ]
      }
      return []
    },
    listen: async () => () => {},
  })
  return calls
}

const REQUEST = { id: 1, query: 'wombat', mode: 'hybrid', limit: 10 } as const

describe('answerSearchIpcRequest', () => {
  afterEach(() => {
    setBridge(null)
  })

  it('never lets a private note reach the CLI, not even its path', async () => {
    fakeApp({ ready: true })
    const answer = await answerSearchIpcRequest(REQUEST, true)
    expect(answer).toEqual({
      mode: 'hybrid',
      results: [
        { path: 'notes/public.md', title: 'Public', snippet: 'a wombat note', score: 1 / 61 },
      ],
    })
  })

  it('over-fetches so dropped private hits still leave a full page', async () => {
    fakeApp({ ready: false, privateFirst: true })
    const answer = await answerSearchIpcRequest({ ...REQUEST, limit: 1 }, false)
    expect(answer).toMatchObject({ results: [{ path: 'notes/public.md' }] })
  })

  it('answers lexically, and says so, when semantic search is off or not loaded', async () => {
    const calls = fakeApp({ ready: false })
    const notLoaded = await answerSearchIpcRequest(REQUEST, true)
    expect(notLoaded).toMatchObject({ mode: 'lexical' })

    fakeApp({ ready: true })
    const turnedOff = await answerSearchIpcRequest(REQUEST, false)
    expect(turnedOff).toMatchObject({ mode: 'lexical' })
    expect(calls.some(([command]) => command === 'embed_texts')).toBe(false)
  })

  it('reports a failure as an error answer instead of throwing', async () => {
    setBridge({
      invoke: async () => {
        throw { kind: 'io', message: 'the index is closed' }
      },
      listen: async () => () => {},
    })
    expect(await answerSearchIpcRequest({ ...REQUEST, mode: 'lexical' }, false)).toEqual({
      error: 'the index is closed',
    })
  })
})
