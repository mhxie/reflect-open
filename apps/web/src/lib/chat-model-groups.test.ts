import { describe, expect, it } from 'vitest'
import { chatModelOptions, type AiProviderConfig } from '@reflect/core'
import { groupModelOptions } from '@/lib/chat-model-groups.ts'

const ATTESTED: AiProviderConfig = {
  id: 'ollama',
  provider: 'openai-compatible',
  model: 'llama3.2',
  baseUrl: 'http://localhost:11434/v1',
  keyHint: '',
  onDevice: { baseUrl: 'http://localhost:11434/v1', model: 'llama3.2' },
}

const UNATTESTED: AiProviderConfig = {
  id: 'lmstudio',
  provider: 'openai-compatible',
  model: 'qwen3',
  baseUrl: 'http://localhost:1234/v1',
  keyHint: '',
}

describe('groupModelOptions', () => {
  it('labels only the attested model of an attested entry as on this Mac', () => {
    const providers = [ATTESTED, UNATTESTED]
    const groups = groupModelOptions(chatModelOptions(providers), providers)

    expect(groups.map((group) => group.label)).toEqual([
      'OpenAI-compatible · http://localhost:11434/v1',
      'OpenAI-compatible · http://localhost:1234/v1',
    ])
    expect(groups.map((group) => group.options.map(({ option }) => option.label))).toEqual([
      ['Local model', 'llama3.2 · On this Mac'],
      ['Local model', 'qwen3'],
    ])
  })

  it('keeps model ids and picker values untouched', () => {
    const providers = [ATTESTED]
    const options = chatModelOptions(providers)
    const [group] = groupModelOptions(options, providers)

    expect(group!.options.map(({ option, value }) => [option.modelId, value])).toEqual(
      options.map((option, index) => [option.modelId, String(index)]),
    )
  })
})
