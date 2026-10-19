import { describe, expect, it, vi } from 'vitest'
import { createTestIpcBridgeService } from '../testing/ipc.ts'
import { createTestLoggerService } from '../testing/logger.ts'

import { createEmbeddingRuntimeService, type EmbedStatus } from './embedding-runtime-service.ts'

const READY: EmbedStatus = { status: 'ready', model: 'all-MiniLM-L6-v2', dims: 384 }
const LOADING: EmbedStatus = { status: 'loading' }

function setup() {
  const ipc = createTestIpcBridgeService()
  const logger = createTestLoggerService()
  const runtime = createEmbeddingRuntimeService({ ipc, logger })
  return { ipc, logger, runtime }
}

describe('createEmbeddingRuntimeService', () => {
  it('polls, loads and embeds over the runtime commands', async () => {
    const { ipc, runtime } = setup()
    ipc.onCommand('embed_status', () => ({ status: 'uninitialized' }))
    ipc.onCommand('embed_ensure', () => READY)
    ipc.onCommand('embed_texts', () => [[0.5, 0.5]])

    await expect(runtime.status()).resolves.toEqual({ status: 'uninitialized' })
    await expect(runtime.ensure()).resolves.toEqual(READY)
    await expect(runtime.embedTexts(['hello'])).resolves.toEqual([[0.5, 0.5]])
    expect(ipc.calls().slice(1)).toEqual([
      { command: 'embed_ensure', args: { model: null } },
      { command: 'embed_texts', args: { texts: ['hello'], role: 'passage', model: null } },
    ])
  })

  it('loads the chosen model and embeds a query for the model the caller expects', async () => {
    const { ipc, runtime } = setup()
    const gemma: EmbedStatus = { status: 'ready', model: 'embeddinggemma-300m', dims: 768 }
    ipc.onCommand('embed_ensure', () => gemma)
    ipc.onCommand('embed_texts', () => [[1, 0]])

    await expect(runtime.ensure('embeddinggemma-300m')).resolves.toEqual(gemma)
    await runtime.embedTexts(['what did I plan'], 'query', 'embeddinggemma-300m')

    expect(ipc.calls()).toEqual([
      { command: 'embed_ensure', args: { model: 'embeddinggemma-300m' } },
      {
        command: 'embed_texts',
        args: { texts: ['what did I plan'], role: 'query', model: 'embeddinggemma-300m' },
      },
    ])
  })

  it('remembers the last observed status and notifies subscribers', async () => {
    const { ipc, runtime } = setup()
    ipc.onCommand('embed_status', () => LOADING)
    expect(runtime.lastStatus()).toEqual({ status: 'uninitialized' })

    const seen: EmbedStatus[] = []
    const unlisten = runtime.subscribe((status) => {
      seen.push(status)
    })
    await runtime.status()
    ipc.emit('embed:status', READY)
    unlisten()
    ipc.emit('embed:status', { status: 'failed', message: 'offline' })

    expect(seen).toEqual([LOADING, READY])
    expect(runtime.lastStatus()).toEqual(READY)
  })

  it('logs an invalid status event', () => {
    const { ipc, logger, runtime } = setup()
    runtime.subscribe(() => {})
    ipc.emit('embed:status', { status: 'mystery' })

    expect(runtime.lastStatus()).toEqual({ status: 'uninitialized' })
    expect(logger.getErrors()).toHaveLength(1)
  })

  it('logs a failed event subscription', async () => {
    const { ipc, logger } = setup()
    vi.spyOn(ipc, 'listen').mockRejectedValue(new Error('no events'))
    const runtime = createEmbeddingRuntimeService({ ipc, logger })
    runtime.subscribe(() => {})
    await vi.waitFor(() => expect(logger.getWarnings()).toHaveLength(1))
  })

  describe('awaitTerminalStatus', () => {
    it('resolves a terminal status at once', async () => {
      const { runtime } = setup()
      await expect(runtime.awaitTerminalStatus({ status: 'unsupported' })).resolves.toEqual({
        status: 'unsupported',
      })
    })

    it('waits for a terminal event after a racing load', async () => {
      const { ipc, runtime } = setup()
      ipc.onCommand('embed_status', () => LOADING)

      const pending = runtime.awaitTerminalStatus(LOADING)
      await vi.waitFor(() => {
        expect(ipc.calls().map((call) => call.command)).toContain('embed_status')
      })
      ipc.emit('embed:status', READY)

      await expect(pending).resolves.toEqual(READY)
    })

    it('re-polls once the listener lands, in case the event already fired', async () => {
      const { ipc, runtime } = setup()
      ipc.onCommand('embed_status', () => READY)
      await expect(runtime.awaitTerminalStatus(LOADING)).resolves.toEqual(READY)
    })

    it('settles as failed when the status events cannot be heard', async () => {
      const { ipc, logger } = setup()
      ipc.onCommand('embed_status', () => LOADING)
      vi.spyOn(ipc, 'listen').mockRejectedValue(new Error('no event channel'))
      const runtime = createEmbeddingRuntimeService({ ipc, logger })

      await expect(runtime.awaitTerminalStatus(LOADING)).resolves.toEqual({
        status: 'failed',
        message: 'no event channel',
      })
    })
  })

  describe('retry', () => {
    it('re-loads a failed model', async () => {
      const { ipc, runtime } = setup()
      ipc.onCommand('embed_status', () => ({ status: 'failed', message: 'offline' }))
      ipc.onCommand('embed_ensure', () => READY)

      await expect(runtime.retry()).resolves.toEqual(READY)
    })

    it('re-loads the model it is given', async () => {
      const { ipc, runtime } = setup()
      ipc.onCommand('embed_status', () => ({ status: 'failed', message: 'offline' }))
      ipc.onCommand('embed_ensure', () => READY)

      await runtime.retry('embeddinggemma-300m')
      expect(ipc.calls()[1]).toEqual({
        command: 'embed_ensure',
        args: { model: 'embeddinggemma-300m' },
      })
    })

    it('leaves any other status alone', async () => {
      const { ipc, runtime } = setup()
      ipc.onCommand('embed_status', () => READY)

      await expect(runtime.retry()).resolves.toEqual(READY)
      expect(ipc.calls().map((call) => call.command)).toEqual(['embed_status'])
    })

    it('resolves a throwing re-load as failed', async () => {
      const { ipc, runtime } = setup()
      ipc.onCommand('embed_status', () => ({ status: 'failed', message: 'offline' }))
      ipc.onCommand('embed_ensure', () => {
        throw new Error('no disk space')
      })

      await expect(runtime.retry()).resolves.toMatchObject({ status: 'failed' })
    })
  })
})
