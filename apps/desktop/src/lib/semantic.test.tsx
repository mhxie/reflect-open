import { afterEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '@reflect/core'
import {
  consumeLegacySemanticOptIn,
  ensureEmbeddingsVisibly,
  retryFailedEmbeddings,
} from './semantic.ts'

afterEach(() => {
  setBridge(null)
})

describe('consumeLegacySemanticOptIn', () => {
  it('returns a stored opt-in exactly once (the settings document owns it after)', () => {
    localStorage.setItem('reflect.semantic.enabled', 'true')
    expect(consumeLegacySemanticOptIn()).toBe(true)
    expect(consumeLegacySemanticOptIn()).toBe(false)
    expect(localStorage.getItem('reflect.semantic.enabled')).toBeNull()
  })

  it('is false when the legacy key was never set', () => {
    expect(consumeLegacySemanticOptIn()).toBe(false)
  })
})

describe('retryFailedEmbeddings', () => {
  function bridgeWithStatus(status: unknown): string[] {
    const invoked: string[] = []
    setBridge({
      invoke: async (command) => {
        invoked.push(command)
        return status
      },
      listen: async () => () => {},
    })
    return invoked
  }

  it('re-kicks a failed load', async () => {
    const invoked = bridgeWithStatus({ status: 'failed', message: 'offline' })
    await retryFailedEmbeddings('embeddinggemma-300m')
    expect(invoked).toContain('embed_ensure')
  })

  it('is a no-op for any other status', async () => {
    const invoked = bridgeWithStatus({ status: 'ready', model: 'all-MiniLM-L6-v2', dims: 384 })
    await retryFailedEmbeddings('all-MiniLM-L6-v2')
    expect(invoked).toEqual(['embed_status'])
  })
})

describe('ensureEmbeddingsVisibly', () => {
  it('resolves only at a terminal status (a racing ensure returns loading)', async () => {
    // Boxed: TS control-flow analysis doesn't track closure assignments and
    // would narrow a plain `let` to `never` at the call site below.
    const emitter: { fire: ((payload: unknown) => void) | null } = { fire: null }
    const ensured: unknown[] = []
    setBridge({
      invoke: async (command, args) => {
        if (command === 'embed_ensure') {
          ensured.push(args)
          return { status: 'loading' } // someone else is mid-download
        }
        if (command === 'embed_status') {
          return { status: 'loading' }
        }
        return null
      },
      listen: async (_event, handler) => {
        emitter.fire = handler
        return () => {
          emitter.fire = null
        }
      },
    })

    const pending = ensureEmbeddingsVisibly('embeddinggemma-300m')
    await vi.waitFor(() => expect(emitter.fire).not.toBeNull())
    expect(ensured).toEqual([{ model: 'embeddinggemma-300m' }])

    emitter.fire?.({ status: 'ready', model: 'embeddinggemma-300m', dims: 768 })
    const status = await pending
    expect(status).toEqual({ status: 'ready', model: 'embeddinggemma-300m', dims: 768 })
  })

  it('returns a failed status when the load fails', async () => {
    setBridge({
      invoke: async (command) =>
        command === 'embed_ensure' ? { status: 'failed', message: 'no disk space' } : null,
      listen: async () => () => {},
    })
    const status = await ensureEmbeddingsVisibly('all-MiniLM-L6-v2')
    expect(status).toEqual({ status: 'failed', message: 'no disk space' })
  })

  it('settles as failed when the status subscription cannot be made', async () => {
    setBridge({
      invoke: async (command) => (command === 'embed_ensure' ? { status: 'loading' } : null),
      listen: async () => {
        throw new Error('no event channel')
      },
    })
    const status = await ensureEmbeddingsVisibly('all-MiniLM-L6-v2')
    expect(status).toEqual({ status: 'failed', message: 'no event channel' })
  })
})
