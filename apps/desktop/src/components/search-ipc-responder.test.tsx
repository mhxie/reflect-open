import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { SearchIpcAnswer, SearchIpcRequest } from '@reflect/core'
import { createTestCoreServices } from '@reflect/core/testing'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { SearchIpcResponder } from './search-ipc-responder.tsx'

const REQUEST: SearchIpcRequest = { id: 7, query: 'wombat', mode: 'hybrid', limit: 10 }

const ANSWER: SearchIpcAnswer = {
  mode: 'hybrid',
  results: [{ path: 'notes/a.md', title: 'A', snippet: 'a', score: 1 }],
}

/**
 * Core services whose IPC answers the CLI socket commands, with the search
 * answer scripted (`SearchIpcService.answer` itself is tested in core).
 */
function setup() {
  const app = createTestCoreServices({ database: createWasmTestDatabaseService() })
  onTestFinished(() => app.database.close())
  const { ipc } = app
  for (const command of ['search_ipc_start', 'search_ipc_stop', 'search_ipc_respond']) {
    ipc.onCommand(command, () => null)
  }
  const answer = vi.spyOn(app.searchIpc, 'answer').mockResolvedValue(ANSWER)
  const socketCalls = () => {
    return ipc
      .calls()
      .filter((call) => call.command.startsWith('search_ipc_'))
      .map((call) => call.command)
  }
  return { app, ipc, answer, socketCalls }
}

describe('SearchIpcResponder', () => {
  it('serves the open graph and answers each request', async () => {
    const { app, ipc, answer, socketCalls } = setup()
    await renderInApp(<SearchIpcResponder />, { app })
    await vi.waitFor(() => expect(socketCalls()).toEqual(['search_ipc_start']))

    ipc.emit('search-ipc:request', REQUEST)
    await vi.waitFor(() => {
      expect(ipc.calls()).toContainEqual({
        command: 'search_ipc_respond',
        args: { id: 7, answer: ANSWER },
      })
    })
    expect(answer).toHaveBeenCalledWith(REQUEST)
  })

  it('stops serving when the workspace goes away', async () => {
    const { app, ipc, answer, socketCalls } = setup()
    const view = await renderInApp(<SearchIpcResponder />, { app })
    await vi.waitFor(() => expect(socketCalls()).toEqual(['search_ipc_start']))

    await view.unmount()
    await vi.waitFor(() => expect(socketCalls()).toEqual(['search_ipc_start', 'search_ipc_stop']))

    // The request listener went with it.
    ipc.emit('search-ipc:request', REQUEST)
    expect(answer).not.toHaveBeenCalled()
  })

  it('serves nothing without an open graph', async () => {
    const { app, ipc, answer, socketCalls } = setup()
    await renderInApp(<SearchIpcResponder />, { app, graph: null })

    ipc.emit('search-ipc:request', REQUEST)
    expect(socketCalls()).toEqual([])
    expect(answer).not.toHaveBeenCalled()
  })
})
