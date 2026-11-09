import { act } from '@/test-utils/act.ts'
import { describe, expect, it } from 'vitest'
import type { AiProviderConfig, OpenAiCompatibleProviderConfig } from '@reflect/core'
import { renderHookInApp } from '@/test-utils/render-in-app.tsx'
import { useAiProviders } from './use-ai-providers.ts'

const ATTESTED = {
  id: 'ollama',
  provider: 'openai-compatible',
  model: 'llama3.2',
  baseUrl: 'http://localhost:11434/v1',
  keyHint: '',
  onDevice: { baseUrl: 'http://localhost:11434/v1', model: 'llama3.2' },
} as const satisfies OpenAiCompatibleProviderConfig

/**
 * Render the hook over `providers`, the stored settings.
 */
async function renderLoaded(providers: AiProviderConfig[]) {
  return await renderHookInApp(() => useAiProviders(), {
    settings: { aiProviders: providers, defaultAiProviderId: 'ollama' },
  })
}

/** The OpenAI-compatible entry at `index` of `providers`. */
function local(providers: readonly AiProviderConfig[], index: number) {
  const entry = providers[index]
  if (entry?.provider !== 'openai-compatible') {
    throw new Error(`no OpenAI-compatible entry at ${index}`)
  }
  return entry
}

describe('useAiProviders', () => {
  it('drops the attestation when the default model changes, and keeps it for the same model', async () => {
    const { result } = await renderLoaded([ATTESTED])

    await act(() => {
      result.current.setDefaultModel('ollama', 'llama3.2')
    })
    expect(result.current.providers[0]).toMatchObject({ onDevice: ATTESTED.onDevice })

    await act(() => {
      result.current.setDefaultModel('ollama', 'qwen3')
    })
    expect(result.current.providers[0]).toMatchObject({ model: 'qwen3', onDevice: null })
  })

  it('attests an endpoint on this Mac for its current model, refuses a LAN one, and withdraws', async () => {
    const lan: OpenAiCompatibleProviderConfig = {
      id: 'lan',
      provider: 'openai-compatible',
      model: 'llama3.2',
      baseUrl: 'http://192.168.1.5:11434/v1',
      keyHint: '',
    }
    const { result, core: app } = await renderLoaded([{ ...ATTESTED, onDevice: null }, lan])

    await act(() => {
      result.current.setOnDevice('ollama', true)
      result.current.setOnDevice('lan', true)
    })
    expect(local(app.settings.get().aiProviders, 0)).toEqual(ATTESTED)
    expect(local(app.settings.get().aiProviders, 1).onDevice ?? null).toBeNull()

    await act(() => {
      result.current.setOnDevice('ollama', false)
    })
    expect(result.current.providers[0]).toMatchObject({ onDevice: null })
  })

  it('stores an attestation from the add form only when requested for a loopback endpoint', async () => {
    const hosted: AiProviderConfig = {
      id: 'hosted',
      provider: 'openai',
      model: 'gpt-5.5',
      keyHint: 'wxyz1',
    }
    const { result, core: app } = await renderLoaded([hosted])
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

    const saved = app.settings.get().aiProviders
    expect(saved).toHaveLength(4)
    expect(local(saved, 1)).toMatchObject({
      baseUrl: 'http://localhost:11434/v1',
      onDevice: { baseUrl: 'http://localhost:11434/v1', model: 'llama3.2' },
      contextWindow: 16_384,
      supportsImages: true,
    })
    for (const index of [2, 3]) {
      expect(local(saved, index)).toMatchObject({ contextWindow: 16_384, supportsImages: true })
      expect(local(saved, index).onDevice ?? null).toBeNull()
    }
  })

  it('changes the declared image support and context window', async () => {
    const { result, core: app } = await renderLoaded([ATTESTED])

    await act(() => {
      result.current.setCapabilities('ollama', { supportsImages: true, contextWindow: 8192 })
    })
    expect(local(app.settings.get().aiProviders, 0)).toMatchObject({
      supportsImages: true,
      contextWindow: 8192,
    })

    await act(() => {
      result.current.setCapabilities('ollama', { contextWindow: null })
    })
    expect(local(app.settings.get().aiProviders, 0).contextWindow).toBeUndefined()
    expect(local(app.settings.get().aiProviders, 0).supportsImages).toBe(true)
  })
})
