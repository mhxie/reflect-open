import { describe, expect, it } from 'vitest'
import { chatModelOptions, resolveChatModel } from '../ai/chat/model-options.ts'
import { DEFAULT_OPENAI_COMPATIBLE_MODEL } from '../ai/openai-compatible.ts'
import type { AiProvidersState } from '../ai/provider-config.ts'
import type { AiProviderConfig, OpenAiCompatibleProviderConfig } from '../settings/schema.ts'
import { createTestHttpService } from '../testing/http.ts'
import {
  cloudTarget,
  isOnDeviceOption,
  modelTarget,
  pickOnDeviceProvider,
  resolveOnDeviceTarget,
  verifyModelTarget,
  withOnDeviceModel,
} from './on-device.ts'
import type { OnDeviceTarget } from './on-device-target.ts'
import { verifyOnDeviceServer } from './on-device-verification.ts'

const OLLAMA_URL = 'http://localhost:11434/v1'

function local(
  overrides: Partial<OpenAiCompatibleProviderConfig> = {},
): OpenAiCompatibleProviderConfig {
  return {
    id: 'ollama',
    provider: 'openai-compatible',
    model: 'llama3.2',
    baseUrl: OLLAMA_URL,
    keyHint: '',
    ...overrides,
  }
}

/** An entry attested for its own endpoint and model. */
function attested(
  overrides: Partial<OpenAiCompatibleProviderConfig> = {},
): OpenAiCompatibleProviderConfig {
  const entry = local(overrides)
  return { ...entry, onDevice: { baseUrl: entry.baseUrl, model: entry.model } }
}

const HOSTED: AiProviderConfig = {
  id: 'anthropic',
  provider: 'anthropic',
  model: 'claude-sonnet-5-5',
  keyHint: 'wxyz1',
}

describe('resolveOnDeviceTarget', () => {
  it('mints a target for an attested entry whose endpoint and model match', () => {
    const entry = attested()
    const target = resolveOnDeviceTarget(entry)
    expect(target).toEqual({ kind: 'on-device', config: entry })
  })

  it('refuses a resolved model other than the attested one', () => {
    const state: AiProvidersState = { providers: [attested()], defaultProviderId: 'ollama' }
    for (const modelId of [
      DEFAULT_OPENAI_COMPATIBLE_MODEL,
      'gpt-oss:120b-cloud',
      'llama3.2:latest',
    ]) {
      const resolved = resolveChatModel(state, { configId: 'ollama', modelId })
      expect(resolveOnDeviceTarget(resolved!), modelId).toBeNull()
    }
  })

  it('refuses an attestation whose endpoint was hand-edited away', () => {
    const entry = attested()
    expect(resolveOnDeviceTarget({ ...entry, baseUrl: 'http://localhost:11435/v1' })).toBeNull()
    expect(
      resolveOnDeviceTarget({
        ...entry,
        onDevice: { baseUrl: 'http://127.0.0.1:11434/v1', model: entry.model },
      }),
    ).toBeNull()
  })

  it('refuses an attestation on a LAN endpoint, and entries without one', () => {
    expect(resolveOnDeviceTarget(attested({ baseUrl: 'http://192.168.1.5:11434/v1' }))).toBeNull()
    expect(resolveOnDeviceTarget(local())).toBeNull()
    expect(resolveOnDeviceTarget(local({ onDevice: null }))).toBeNull()
    expect(resolveOnDeviceTarget(HOSTED)).toBeNull()
  })

  it('cannot be forged from an object literal', () => {
    // @ts-expect-error: only resolveOnDeviceTarget mints an OnDeviceTarget.
    const forged: OnDeviceTarget = { kind: 'on-device', config: attested() }
    expect(forged.kind).toBe('on-device')
  })

  it('holds a frozen copy of the config', () => {
    const entry = attested()
    const target = resolveOnDeviceTarget(entry)!
    expect(Object.isFrozen(target)).toBe(true)
    expect(Object.isFrozen(target.config)).toBe(true)
    expect(Object.isFrozen(target.config.onDevice)).toBe(true)
    expect(() => {
      Object.assign(target.config, { baseUrl: 'http://localhost:9999/v1' })
    }).toThrow(TypeError)
    // Later edits to the settings entry never reach the minted target.
    entry.model = 'something-else'
    expect(target.config.model).toBe('llama3.2')
  })
})

describe('modelTarget', () => {
  it('keeps an unattested loopback entry, and every hosted one, in the cloud tier', () => {
    for (const config of [local(), local({ onDevice: null }), HOSTED]) {
      const target = modelTarget(config)
      expect(target).toEqual({ kind: 'cloud', config })
      expect(Object.isFrozen(target.config)).toBe(true)
    }
  })

  it('returns the on-device target when the attestation matches', () => {
    expect(modelTarget(attested()).kind).toBe('on-device')
  })
})

describe('cloudTarget', () => {
  it('keeps a frozen copy of a hosted entry', () => {
    const config = { id: 'openai', provider: 'openai' as const, model: 'gpt-5.5', keyHint: '' }
    const target = cloudTarget(config)
    expect(target).toEqual({ kind: 'cloud', config })
    expect(Object.isFrozen(target.config)).toBe(true)
    config.model = 'something-else'
    expect(target.config.model).toBe('gpt-5.5')
  })
})

describe('verifyModelTarget', () => {
  it('passes a cloud target through without checking any server', async () => {
    const checked: OnDeviceTarget[] = []
    const cloud = modelTarget(HOSTED)
    await expect(
      verifyModelTarget(cloud, (target) => {
        checked.push(target)
        return Promise.resolve('ok')
      }),
    ).resolves.toBe(cloud)
    expect(checked).toEqual([])
  })

  it('verifies an on-device target only once its server accepts it', async () => {
    const onDevice = modelTarget(attested())
    const verified = await verifyModelTarget(onDevice, () => Promise.resolve('ok'))
    expect(verified).toBe(onDevice)
    expect(verified.kind).toBe('on-device')
  })

  it('refuses with the reason when the server is refused, never falling back to cloud', async () => {
    await expect(
      verifyModelTarget(modelTarget(attested()), () =>
        Promise.resolve({ kind: 'refused', reason: 'Choose a model running on this Mac.' }),
      ),
    ).rejects.toMatchObject({ kind: 'auth', message: 'Choose a model running on this Mac.' })
  })
})

describe('isOnDeviceOption', () => {
  it('marks only the attested model of an attested entry', () => {
    const state: AiProvidersState = {
      providers: [
        attested(),
        HOSTED,
        local({ id: 'lmstudio', baseUrl: 'http://localhost:1234/v1' }),
      ],
      defaultProviderId: 'anthropic',
    }
    const onDevice = chatModelOptions(state.providers)
      .filter((option) => isOnDeviceOption(state, option))
      .map((option) => `${option.configId}/${option.modelId}`)
    expect(onDevice).toEqual(['ollama/llama3.2'])
  })
})

describe('pickOnDeviceProvider', () => {
  const first = attested({ id: 'first', model: 'qwen3' })
  const second = attested({ id: 'second', baseUrl: 'http://localhost:1234/v1' })

  it('prefers the default entry when it resolves on-device', () => {
    const state = { providers: [first, second], defaultProviderId: 'second' }
    expect(pickOnDeviceProvider(state)?.config.id).toBe('second')
  })

  it('falls back to the first entry that resolves on-device', () => {
    const state = { providers: [HOSTED, local(), first, second], defaultProviderId: 'anthropic' }
    expect(pickOnDeviceProvider(state)?.config.id).toBe('first')
  })

  it('finds nothing when no entry resolves on-device', () => {
    expect(
      pickOnDeviceProvider({ providers: [HOSTED, local()], defaultProviderId: null }),
    ).toBeNull()
    expect(pickOnDeviceProvider({ providers: [], defaultProviderId: null })).toBeNull()
  })
})

describe('withOnDeviceModel', () => {
  const ids = (): string => 'new-entry'

  it('reuses an entry already attested for the model, changing nothing', () => {
    const state: AiProvidersState = {
      providers: [HOSTED, attested({ id: 'gemma', model: 'gemma4:31b' })],
      defaultProviderId: HOSTED.id,
    }
    const result = withOnDeviceModel(state, `${OLLAMA_URL}/`, 'gemma4:31b', 'ollama', ids)
    expect(result).toEqual({ state, id: 'gemma' })
  })

  it('attests an entry that already runs the model there, leaving other entries alone', () => {
    const other = attested({ id: 'llama' })
    const state: AiProvidersState = {
      providers: [other, local({ id: 'qwen', model: 'qwen3.8:27b' })],
      defaultProviderId: other.id,
    }
    const result = withOnDeviceModel(state, OLLAMA_URL, 'qwen3.8:27b', 'ollama', ids)
    expect(result.id).toBe('qwen')
    expect(result.state.providers).toEqual([
      other,
      {
        ...local({ id: 'qwen', model: 'qwen3.8:27b' }),
        onDevice: { baseUrl: OLLAMA_URL, model: 'qwen3.8:27b', server: 'ollama' },
      },
    ])
    expect(result.state.defaultProviderId).toBe('llama')
  })

  it('adds a keyless attested entry for a model nothing runs yet, not as the default', () => {
    const other = attested({ id: 'llama' })
    const result = withOnDeviceModel(
      { providers: [HOSTED, other], defaultProviderId: HOSTED.id },
      OLLAMA_URL,
      'gemma4:31b',
      'ollama',
      ids,
    )
    expect(result.id).toBe('new-entry')
    expect(result.state.defaultProviderId).toBe(HOSTED.id)
    const added = result.state.providers.at(-1)!
    expect(added).toEqual({
      id: 'new-entry',
      provider: 'openai-compatible',
      model: 'gemma4:31b',
      baseUrl: OLLAMA_URL,
      keyHint: '',
      onDevice: { baseUrl: OLLAMA_URL, model: 'gemma4:31b', server: 'ollama' },
    })
    expect(resolveOnDeviceTarget(added)).not.toBeNull()
    // The other attested entry keeps its model and its attestation.
    expect(result.state.providers[1]).toBe(other)
  })
})

describe('verifyOnDeviceServer', () => {
  it('refuses an unverified server before any private context is sent', async () => {
    // Every request answers 404: no Ollama API, and no generic server attested.
    expect(
      await verifyOnDeviceServer(createTestHttpService(), resolveOnDeviceTarget(attested())!),
    ).toMatchObject({ kind: 'refused' })
  })
})
