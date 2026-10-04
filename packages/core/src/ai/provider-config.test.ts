import { describe, expect, it } from 'vitest'
import type {
  AiProviderConfig,
  HostedAiProviderConfig,
  OpenAiCompatibleProviderConfig,
} from '../settings/schema.ts'
import {
  apiKeyHint,
  defaultAiProvider,
  pickTranscriptionConfig,
  resolveTranscriptionTarget,
  withAiProviderAdded,
  withAiProviderCapabilities,
  withAiProviderModel,
  withAiProviderOnDevice,
  withAiProviderRemoved,
  type AiProvidersState,
} from './provider-config.ts'

function config(overrides: Partial<HostedAiProviderConfig>): HostedAiProviderConfig {
  return {
    id: 'id',
    provider: 'openai',
    model: 'gpt-5.1',
    keyHint: 'hint1',
    ...overrides,
  }
}

function state(providers: AiProviderConfig[], defaultProviderId: string | null): AiProvidersState {
  return { providers, defaultProviderId }
}

function local(
  overrides: Partial<OpenAiCompatibleProviderConfig> = {},
): OpenAiCompatibleProviderConfig {
  return {
    id: 'ollama',
    provider: 'openai-compatible',
    model: 'llama3.2',
    baseUrl: 'http://localhost:11434/v1',
    keyHint: '',
    ...overrides,
  }
}

const ATTESTATION = { baseUrl: 'http://localhost:11434/v1', model: 'llama3.2' }

describe('withAiProviderModel', () => {
  it('drops an attestation for another model and keeps one for the same model', () => {
    const attested = local({ onDevice: ATTESTATION })
    const other = config({ id: 'other' })

    expect(withAiProviderModel([attested, other], 'ollama', 'qwen3')).toEqual([
      { ...attested, model: 'qwen3', onDevice: null },
      other,
    ])
    expect(withAiProviderModel([attested], 'ollama', 'llama3.2')).toEqual([attested])
    expect(withAiProviderModel([other], 'other', 'gpt-5.5')).toEqual([
      { ...other, model: 'gpt-5.5' },
    ])
  })
})

describe('withAiProviderOnDevice', () => {
  it('attests the entry for exactly its current endpoint and model', () => {
    expect(withAiProviderOnDevice([local()], 'ollama', true)).toEqual([
      local({ onDevice: ATTESTATION }),
    ])
  })

  it('refuses to attest an endpoint off this Mac, or a hosted entry', () => {
    const lan = local({ baseUrl: 'http://192.168.1.5:11434/v1' })
    const hosted = config({ id: 'hosted' })
    expect(withAiProviderOnDevice([lan, hosted], 'ollama', true)).toEqual([lan, hosted])
    expect(withAiProviderOnDevice([lan, hosted], 'hosted', true)).toEqual([lan, hosted])
  })

  it('withdraws an attestation, even a stale one', () => {
    const stale = local({ baseUrl: 'http://192.168.1.5:11434/v1', onDevice: ATTESTATION })
    expect(withAiProviderOnDevice([stale], 'ollama', false)).toEqual([{ ...stale, onDevice: null }])
  })
})

describe('withAiProviderCapabilities', () => {
  it('sets and clears image support and the context window', () => {
    const withBoth = withAiProviderCapabilities([local()], 'ollama', {
      supportsImages: true,
      contextWindow: 32_768,
    })
    expect(withBoth).toEqual([local({ supportsImages: true, contextWindow: 32_768 })])
    expect(withAiProviderCapabilities(withBoth, 'ollama', { contextWindow: null })).toEqual([
      local({ supportsImages: true }),
    ])
  })

  it('ignores a context window that is too small or fractional, and hosted entries', () => {
    const entry = local({ contextWindow: 8192 })
    for (const contextWindow of [1024, 8192.5, NaN]) {
      expect(withAiProviderCapabilities([entry], 'ollama', { contextWindow })).toEqual([entry])
    }
    const hosted = config({ id: 'hosted' })
    expect(withAiProviderCapabilities([hosted], 'hosted', { supportsImages: true })).toEqual([
      hosted,
    ])
  })
})

describe('apiKeyHint', () => {
  it('keeps only the trailing characters of a key', () => {
    expect(apiKeyHint('sk-ant-api03-secret-wxyz1')).toBe('wxyz1')
  })

  it('returns no hint for a key short enough that it would reveal most of it', () => {
    expect(apiKeyHint('abc')).toBe('')
    expect(apiKeyHint('123456789')).toBe('')
    expect(apiKeyHint('1234567890')).toBe('67890')
  })
})

describe('withAiProviderAdded', () => {
  it('makes the first entry the default even when not requested', () => {
    expect(withAiProviderAdded(state([], null), config({ id: 'a' }), false)).toEqual(
      state([config({ id: 'a' })], 'a'),
    )
  })

  it('appends a non-default entry without touching the default', () => {
    const before = state([config({ id: 'a' })], 'a')
    expect(withAiProviderAdded(before, config({ id: 'b' }), false)).toEqual(
      state([config({ id: 'a' }), config({ id: 'b' })], 'a'),
    )
  })

  it('an entry added as default takes over', () => {
    const before = state([config({ id: 'a' })], 'a')
    expect(withAiProviderAdded(before, config({ id: 'b' }), true).defaultProviderId).toBe('b')
  })
})

describe('withAiProviderRemoved', () => {
  it('removes the entry with the id', () => {
    const before = state([config({ id: 'a' }), config({ id: 'b' })], 'a')
    expect(withAiProviderRemoved(before, 'b')).toEqual(state([config({ id: 'a' })], 'a'))
  })

  it('promotes the first remaining entry when the default is removed', () => {
    const before = state([config({ id: 'a' }), config({ id: 'b' })], 'a')
    expect(withAiProviderRemoved(before, 'a')).toEqual(state([config({ id: 'b' })], 'b'))
  })

  it('removing the last entry clears the default', () => {
    expect(withAiProviderRemoved(state([config({ id: 'a' })], 'a'), 'a')).toEqual(state([], null))
  })
})

describe('pickTranscriptionConfig', () => {
  it('prefers any openai entry over a google default', () => {
    const providers = [
      config({ id: 'gemini', provider: 'google', model: 'gemini-2.5-flash' }),
      config({ id: 'oai', provider: 'openai' }),
    ]
    expect(pickTranscriptionConfig(state(providers, 'gemini'))?.id).toBe('oai')
  })

  it('prefers the app default among entries of the chosen provider', () => {
    const providers = [config({ id: 'first' }), config({ id: 'second' })]
    expect(pickTranscriptionConfig(state(providers, 'second'))?.id).toBe('second')
  })

  it('falls back to google when no openai entry exists', () => {
    const providers = [
      config({ id: 'claude', provider: 'anthropic', model: 'claude-fable-5' }),
      config({ id: 'gemini', provider: 'google', model: 'gemini-2.5-flash' }),
    ]
    expect(pickTranscriptionConfig(state(providers, 'claude'))?.id).toBe('gemini')
  })

  it('returns null when only non-transcription providers exist', () => {
    const providers = [
      config({ id: 'claude', provider: 'anthropic', model: 'claude-fable-5' }),
      config({ id: 'openrouter', provider: 'openrouter', model: 'openrouter/auto' }),
    ]
    expect(pickTranscriptionConfig(state(providers, 'claude'))).toBeNull()
  })

  it('returns null for the empty list', () => {
    expect(pickTranscriptionConfig(state([], null))).toBeNull()
  })
})

describe('defaultAiProvider', () => {
  it('returns the entry the id points at', () => {
    const providers = [config({ id: 'a' }), config({ id: 'b' })]
    expect(defaultAiProvider(state(providers, 'b'))?.id).toBe('b')
  })

  it('falls back to the first entry for a null or dangling id', () => {
    const providers = [config({ id: 'a' }), config({ id: 'b' })]
    expect(defaultAiProvider(state(providers, null))?.id).toBe('a')
    expect(defaultAiProvider(state(providers, 'gone'))?.id).toBe('a')
  })

  it('returns null for the empty list', () => {
    expect(defaultAiProvider(state([], null))).toBeNull()
  })
})

describe('resolveTranscriptionTarget', () => {
  const keyed =
    (available: Record<string, string>) =>
    (id: string): Promise<string | null> =>
      Promise.resolve(available[id] ?? null)

  it('answers no-provider when nothing transcription-capable is configured', async () => {
    const target = await resolveTranscriptionTarget(
      state([config({ id: 'a', provider: 'anthropic' })], 'a'),
      keyed({ a: 'sk-a' }),
    )
    expect(target).toBe('no-provider')
  })

  it('answers no-key when every capable entry is keyless', async () => {
    const target = await resolveTranscriptionTarget(
      state([config({ id: 'openai-1' })], 'openai-1'),
      keyed({}),
    )
    expect(target).toBe('no-key')
  })

  it('prefers OpenAI entries and the app default within a provider', async () => {
    const providers = state(
      [
        config({ id: 'google-1', provider: 'google' }),
        config({ id: 'openai-1' }),
        config({ id: 'openai-2' }),
      ],
      'openai-2',
    )
    const target = await resolveTranscriptionTarget(
      providers,
      keyed({ 'google-1': 'g', 'openai-1': 'o1', 'openai-2': 'o2' }),
    )
    expect(target).toMatchObject({ config: { id: 'openai-2' }, apiKey: 'o2' })
  })

  it('skips a keyless preferred entry instead of blocking a working one', async () => {
    const providers = state(
      [config({ id: 'openai-1' }), config({ id: 'google-1', provider: 'google' })],
      'openai-1',
    )
    const target = await resolveTranscriptionTarget(providers, keyed({ 'google-1': 'g' }))
    expect(target).toMatchObject({ config: { id: 'google-1' }, apiKey: 'g' })
  })
})
