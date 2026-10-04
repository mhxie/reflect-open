import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from 'vitest-browser-react'
import type { ReactNode } from 'react'
import {
  setBridge,
  settingsSchema,
  type AiProviderConfig,
  type OpenAiCompatibleProviderConfig,
} from '@reflect/core'
import { resetOperations } from '@/lib/operations.ts'
import { SettingsProvider } from '@/providers/settings-provider.tsx'
import { useAiProviders } from './use-ai-providers.ts'

let stored: Record<string, unknown>
let saved: unknown[]
let queryClient: QueryClient

function installFakeBridge(): void {
  saved = []
  setBridge({
    invoke: async (command, args) => {
      switch (command) {
        case 'settings_load':
          return stored
        case 'settings_save':
          saved.push(args['settings'])
          return null
        default:
          return null
      }
    },
    listen: async () => () => {},
  })
}

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <SettingsProvider>{children}</SettingsProvider>
    </QueryClientProvider>
  )
}

/** The providers in the most recently persisted document. */
function savedProviders(): AiProviderConfig[] {
  return settingsSchema.parse(saved.at(-1)).aiProviders
}

/** The persisted OpenAI-compatible entry at `index`. */
function savedLocal(index: number): OpenAiCompatibleProviderConfig {
  const entry = savedProviders()[index]
  if (entry?.provider !== 'openai-compatible') {
    throw new Error(`no OpenAI-compatible entry at ${index}`)
  }
  return entry
}

const ATTESTED = {
  id: 'ollama',
  provider: 'openai-compatible',
  model: 'llama3.2',
  baseUrl: 'http://localhost:11434/v1',
  keyHint: '',
  onDevice: { baseUrl: 'http://localhost:11434/v1', model: 'llama3.2' },
} as const

/**
 * Render the hook over a non-empty `providers`, returning once that list
 * rendered: `whenSettingsLoaded` resolves in an effect that an `act` scope
 * would hold back, so no test may start one before the load committed.
 */
async function renderLoaded(providers: unknown[]) {
  stored = { aiProviders: providers, defaultAiProviderId: 'ollama' }
  const rendered = await renderHook(() => useAiProviders(), { wrapper })
  await vi.waitFor(() => expect(rendered.result.current.providers).toHaveLength(providers.length))
  return rendered
}

beforeEach(() => {
  stored = {}
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  installFakeBridge()
})

afterEach(() => {
  setBridge(null)
  queryClient.clear()
  resetOperations()
})

describe('useAiProviders', () => {
  it('drops the attestation when the default model changes, and keeps it for the same model', async () => {
    const { result, act } = await renderLoaded([ATTESTED])

    await act(() => {
      result.current.setDefaultModel('ollama', 'llama3.2')
    })
    expect(result.current.providers[0]).toMatchObject({ onDevice: ATTESTED.onDevice })

    await act(() => {
      result.current.setDefaultModel('ollama', 'qwen3')
    })
    expect(result.current.providers[0]).toMatchObject({ model: 'qwen3', onDevice: null })
    await vi.waitFor(() =>
      expect(savedProviders()[0]).toMatchObject({ model: 'qwen3', onDevice: null }),
    )
  })

  it('attests an endpoint on this Mac for its current model, refuses a LAN one, and withdraws', async () => {
    const lan = {
      id: 'lan',
      provider: 'openai-compatible',
      model: 'llama3.2',
      baseUrl: 'http://192.168.1.5:11434/v1',
      keyHint: '',
    }
    const { result, act } = await renderLoaded([{ ...ATTESTED, onDevice: null }, lan])

    await act(() => {
      result.current.setOnDevice('ollama', true)
      result.current.setOnDevice('lan', true)
    })
    await vi.waitFor(() => expect(savedLocal(0)).toEqual(ATTESTED))
    expect(savedLocal(1).onDevice ?? null).toBeNull()

    await act(() => {
      result.current.setOnDevice('ollama', false)
    })
    await vi.waitFor(() => expect(savedProviders()[0]).toMatchObject({ onDevice: null }))
  })

  it('stores an attestation from the add form only when requested for a loopback endpoint', async () => {
    const hosted = { id: 'hosted', provider: 'openai', model: 'gpt-5.5', keyHint: 'wxyz1' }
    const { result, act } = await renderLoaded([hosted])
    const draft = {
      provider: 'openai-compatible',
      model: 'llama3.2',
      apiKey: '',
      isDefault: false,
      contextWindow: 16_384,
      supportsImages: true,
    } as const

    await act(async () => {
      await result.current.addProvider({
        ...draft,
        baseUrl: 'http://localhost:11434/v1/',
        onDevice: true,
      })
      await result.current.addProvider({
        ...draft,
        baseUrl: 'http://192.168.1.5:1234/v1',
        onDevice: true,
      })
      await result.current.addProvider({ ...draft, baseUrl: 'http://localhost:1234/v1' })
    })

    await vi.waitFor(() => expect(savedProviders()).toHaveLength(4))
    const [, onThisMac, lan, unattested] = savedProviders()
    expect(onThisMac).toMatchObject({
      baseUrl: 'http://localhost:11434/v1',
      onDevice: { baseUrl: 'http://localhost:11434/v1', model: 'llama3.2' },
      contextWindow: 16_384,
      supportsImages: true,
    })
    for (const [index, entry] of [lan, unattested].entries()) {
      expect(entry).toMatchObject({ contextWindow: 16_384, supportsImages: true })
      expect(savedLocal(index + 2).onDevice ?? null).toBeNull()
    }
  })

  it('changes the declared image support and context window', async () => {
    const { result, act } = await renderLoaded([ATTESTED])

    await act(() => {
      result.current.setCapabilities('ollama', { supportsImages: true, contextWindow: 8192 })
    })
    await vi.waitFor(() =>
      expect(savedProviders()[0]).toMatchObject({ supportsImages: true, contextWindow: 8192 }),
    )

    await act(() => {
      result.current.setCapabilities('ollama', { contextWindow: null })
    })
    await vi.waitFor(() => expect(savedLocal(0).contextWindow).toBeUndefined())
    expect(savedLocal(0).supportsImages).toBe(true)
  })
})
