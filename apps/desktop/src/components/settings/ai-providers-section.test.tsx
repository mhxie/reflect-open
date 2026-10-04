import { render } from 'vitest-browser-react'
import { page, userEvent, type Locator } from 'vitest/browser'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  setBridge,
  settingsSchema,
  type HostedAiProviderConfig,
  type Settings,
} from '@reflect/core'
import { SettingsProvider } from '@/providers/settings-provider.tsx'
import { resetOperations } from '@/lib/operations.ts'
import { expectLocatorToHaveCount } from '@/test-utils/expect.ts'
import { AiProvidersSection } from './ai-providers-section.tsx'

// The dialog verifies keys against the provider through this transport; the
// default per-test behavior is "key accepted".
const { providerFetchMock } = vi.hoisted(() => ({ providerFetchMock: vi.fn() }))
vi.mock('@/lib/provider-fetch.ts', () => ({ providerFetch: providerFetchMock }))

let stored: Record<string, unknown>
let saved: unknown[]
let secrets: Map<string, string>
let failSecretSet: boolean
let failLoad: boolean
/** Requests that reached the loopback transport (`on_device_http_send`). */
let onDeviceSends: Record<string, unknown>[]

function installFakeBridge(): void {
  saved = []
  secrets = new Map()
  failSecretSet = false
  failLoad = false
  onDeviceSends = []
  setBridge({
    invoke: async (command, args) => {
      switch (command) {
        case 'on_device_http_send':
          onDeviceSends.push(args)
          return { status: 200, statusText: 'OK', headers: [] }
        case 'on_device_http_read':
          return new ArrayBuffer(0)
        case 'settings_load':
          if (failLoad) {
            throw { kind: 'io', message: 'corrupt store' }
          }
          return stored
        case 'settings_save':
          saved.push(args['settings'])
          return null
        case 'secret_set':
          if (failSecretSet) {
            throw { kind: 'io', message: 'keychain locked' }
          }
          secrets.set(args['name'] as string, args['value'] as string)
          return null
        case 'secret_delete':
          secrets.delete(args['name'] as string)
          return null
        default:
          return null
      }
    },
    listen: async () => () => {},
  })
}

let queryClient: QueryClient

async function renderSection(): Promise<void> {
  await render(
    <QueryClientProvider client={queryClient}>
      <SettingsProvider>
        <AiProvidersSection />
      </SettingsProvider>
    </QueryClientProvider>,
  )
}

/** The most recently persisted document, parsed. */
function lastSavedDoc(): Settings {
  return settingsSchema.parse(saved.at(-1))
}

function entry(overrides: Partial<HostedAiProviderConfig>): HostedAiProviderConfig {
  return {
    id: 'id',
    provider: 'anthropic',
    model: 'claude-opus-4-8',
    keyHint: 'wxyz1',
    ...overrides,
  }
}

/** Two configured entries with 'a' as the default. */
function twoStoredModels(): Record<string, unknown> {
  return {
    aiProviders: [
      entry({ id: 'a' }),
      entry({ id: 'b', provider: 'openai', model: 'gpt-5.5', keyHint: 'abcd2' }),
    ],
    defaultAiProviderId: 'a',
  }
}

async function openDialog(): Promise<Locator> {
  await page.getByRole('button', { name: /add provider/i }).click()
  return page.getByRole('dialog', { name: 'Add AI provider' })
}

beforeEach(() => {
  stored = {}
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  installFakeBridge()
  providerFetchMock.mockReset()
  providerFetchMock.mockResolvedValue(new Response(null, { status: 200 }))
})

afterEach(() => {
  setBridge(null)
  queryClient.clear()
  resetOperations()
})

describe('AiProvidersSection', () => {
  it('lists configured providers with their key hint and default badge', async () => {
    stored = twoStoredModels()
    await renderSection()

    await expect.element(page.getByText('Anthropic')).toBeInTheDocument()
    await expect.element(page.getByText('OpenAI')).toBeInTheDocument()
    await expect
      .element(page.getByRole('combobox', { name: 'Default model for Anthropic' }))
      .toMatchTextContent(/Claude Opus 4\.8/)
    await expect
      .element(page.getByRole('combobox', { name: 'Default model for OpenAI' }))
      .toMatchTextContent(/GPT-5\.5/)
    await expect.element(page.getByText(/wxyz1/)).toBeInTheDocument()
    await expect.element(page.getByText(/abcd2/)).toBeInTheDocument()
    await expect.element(page.getByText('Default', { exact: true })).toBeInTheDocument()
    await expect.element(page.getByRole('button', { name: 'Make default' })).toBeInTheDocument()
  })

  it('adds a model: key verified, then keychain + settings entry', async () => {
    await renderSection()
    await expect.element(page.getByText(/No AI providers configured/)).toBeInTheDocument()

    const dialog = await openDialog()
    // Options render in a portal, so they're queried from the page.
    await dialog.getByRole('combobox', { name: 'Provider' }).click()
    await page.getByRole('option', { name: 'Anthropic' }).click()
    await dialog.getByRole('combobox', { name: 'Default model' }).click()
    await page.getByRole('option', { name: /Claude Sonnet 5\.5/ }).click()
    await dialog.getByLabelText('API key').fill('sk-ant-test-wxyz1')
    await dialog.getByRole('button', { name: 'Add provider' }).click()

    await vi.waitFor(() => expect(saved).toHaveLength(1))
    const doc = lastSavedDoc()
    const [added] = doc.aiProviders
    expect(added).toMatchObject({
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      keyHint: 'wxyz1',
    })
    // The first entry becomes the default automatically.
    expect(doc.defaultAiProviderId).toBe(added!.id)
    // The key was verified against the provider before being stored.
    expect(providerFetchMock).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/models',
      expect.objectContaining({ method: 'GET' }),
    )
    // The full key reached the keychain (and only the keychain).
    expect(secrets.get(`ai-api-key:${added!.id}`)).toBe('sk-ant-test-wxyz1')
    expect(JSON.stringify(saved)).not.toContain('sk-ant-test-wxyz1')
    await expectLocatorToHaveCount(page.getByRole('dialog'), 0)
  })

  it('offers OpenRouter in the provider picker', async () => {
    await renderSection()
    await expect.element(page.getByText(/No AI providers configured/)).toBeInTheDocument()

    const dialog = await openDialog()
    await dialog.getByRole('combobox', { name: 'Provider' }).click()

    await expect.element(page.getByRole('option', { name: 'OpenRouter' })).toBeInTheDocument()
    await expect
      .element(page.getByRole('option', { name: 'OpenAI-compatible' }))
      .toBeInTheDocument()
  })

  it('adds an OpenAI-compatible endpoint without storing an empty key', async () => {
    await renderSection()
    await expect.element(page.getByText(/No AI providers configured/)).toBeInTheDocument()

    const dialog = await openDialog()
    await dialog.getByRole('combobox', { name: 'Provider' }).click()
    await page.getByRole('option', { name: 'OpenAI-compatible' }).click()
    await dialog.getByLabelText('Endpoint base URL').fill('http://localhost:1234/v1/')
    await dialog.getByLabelText('Default model').fill('llama-local')
    await dialog.getByRole('button', { name: 'Add provider' }).click()

    await vi.waitFor(() => expect(saved).toHaveLength(1))
    const doc = lastSavedDoc()
    const [added] = doc.aiProviders
    expect(added).toMatchObject({
      provider: 'openai-compatible',
      model: 'llama-local',
      baseUrl: 'http://localhost:1234/v1',
      keyHint: '',
    })
    // An endpoint on this Mac is probed through the loopback transport only.
    expect(onDeviceSends).toEqual([
      expect.objectContaining({
        method: 'GET',
        url: 'http://localhost:1234/v1/models',
        headers: [],
      }),
    ])
    expect(providerFetchMock).not.toHaveBeenCalled()
    expect(secrets.size).toBe(0)
    expect(JSON.stringify(saved)).not.toContain('localhost:1234/v1/')
    await expectLocatorToHaveCount(page.getByRole('dialog'), 0)
  })

  it('rejects a key the provider turns down, storing nothing', async () => {
    providerFetchMock.mockResolvedValue(new Response(null, { status: 401 }))
    await renderSection()
    await expect.element(page.getByText(/No AI providers configured/)).toBeInTheDocument()

    const dialog = await openDialog()
    await dialog.getByLabelText('API key').fill('sk-typo')
    await dialog.getByRole('button', { name: 'Add provider' }).click()

    await expect.element(dialog.getByRole('alert')).toMatchTextContent(/rejected this API key/i)
    expect(secrets.size).toBe(0)
    expect(saved).toEqual([])
  })

  it('offers save-anyway when the provider cannot be reached', async () => {
    providerFetchMock.mockRejectedValue(new TypeError('offline'))
    await renderSection()
    await expect.element(page.getByText(/No AI providers configured/)).toBeInTheDocument()

    const dialog = await openDialog()
    await dialog.getByLabelText('API key').fill('sk-offline-key')
    await dialog.getByRole('button', { name: 'Add provider' }).click()

    // First submit downgrades to an explicit unverified save, not a block.
    await expect.element(dialog.getByRole('alert')).toMatchTextContent(/reach OpenAI/)
    expect(saved).toEqual([])

    await dialog.getByRole('button', { name: 'Save anyway' }).click()
    await vi.waitFor(() => expect(saved).toHaveLength(1))
    expect(secrets.size).toBe(1)
    await expectLocatorToHaveCount(page.getByRole('dialog'), 0)
  })

  it('a failed keychain write keeps the dialog open and persists nothing', async () => {
    await renderSection()
    await expect.element(page.getByText(/No AI providers configured/)).toBeInTheDocument()
    failSecretSet = true

    const dialog = await openDialog()
    await dialog.getByLabelText('API key').fill('sk-test')
    await dialog.getByRole('button', { name: 'Add provider' }).click()

    await expect.element(dialog.getByRole('alert')).toMatchTextContent(/^keychain locked$/)
    await expect.element(page.getByRole('dialog')).toBeInTheDocument()
    expect(saved).toEqual([])
    expect(secrets.size).toBe(0)
  })

  it('refuses to add when the settings store failed to load (no orphaned key)', async () => {
    failLoad = true
    await renderSection()
    await expect.element(page.getByText(/No AI providers configured/)).toBeInTheDocument()

    const dialog = await openDialog()
    await dialog.getByLabelText('API key').fill('sk-test')
    await dialog.getByRole('button', { name: 'Add provider' }).click()

    // A session-only entry would vanish on restart, stranding the key in the
    // keychain with no UI to delete it — so the key must never be stored.
    await expect.element(dialog.getByRole('alert')).toMatchTextContent(/could not be loaded/i)
    expect(secrets.size).toBe(0)
    expect(saved).toEqual([])
  })

  it('removes a model, deletes its secret, and promotes the next default', async () => {
    stored = twoStoredModels()
    secrets.set('ai-api-key:a', 'sk-a')
    await renderSection()
    await expect.element(page.getByText('Anthropic')).toBeInTheDocument()

    await page.getByRole('button', { name: 'Remove Anthropic — Claude Opus 4.8' }).click()

    await vi.waitFor(() =>
      expect(lastSavedDoc()).toMatchObject({
        aiProviders: [entry({ id: 'b', provider: 'openai', model: 'gpt-5.5', keyHint: 'abcd2' })],
        defaultAiProviderId: 'b',
      }),
    )
    expect(secrets.has('ai-api-key:a')).toBe(false)
  })

  it('overlapping removes both land instead of clobbering each other', async () => {
    stored = twoStoredModels()
    secrets.set('ai-api-key:a', 'sk-a')
    secrets.set('ai-api-key:b', 'sk-b')
    await renderSection()
    await expect.element(page.getByText('Anthropic')).toBeInTheDocument()

    // Both removes fire in the same tick; each suspends on its keychain
    // delete, so each settings update applies after the other's snapshot
    // went stale. A snapshot-based write would leave one row behind with
    // its key already gone from the keychain.
    ;(
      page
        .getByRole('button', { name: 'Remove Anthropic — Claude Opus 4.8' })
        .element() as HTMLElement
    ).click()
    ;(
      page.getByRole('button', { name: 'Remove OpenAI — GPT-5.5' }).element() as HTMLElement
    ).click()

    await vi.waitFor(() =>
      expect(lastSavedDoc()).toMatchObject({ aiProviders: [], defaultAiProviderId: null }),
    )
    expect(secrets.size).toBe(0)
  })

  it('make default moves the id', async () => {
    stored = twoStoredModels()
    await renderSection()
    await expect.element(page.getByRole('button', { name: 'Make default' })).toBeInTheDocument()

    await page.getByRole('button', { name: 'Make default' }).click()

    await vi.waitFor(() => expect(lastSavedDoc().defaultAiProviderId).toBe('b'))
    expect(lastSavedDoc().aiProviders).toHaveLength(2)
  })

  it('changes a configured provider default model without replacing its key', async () => {
    stored = twoStoredModels()
    secrets.set('ai-api-key:b', 'sk-openai-secret')
    await renderSection()

    await page.getByRole('combobox', { name: 'Default model for OpenAI' }).click()
    await page.getByRole('option', { name: /GPT-5\.4 mini/ }).click()

    await vi.waitFor(() => {
      expect(lastSavedDoc().aiProviders).toContainEqual(
        entry({ id: 'b', provider: 'openai', model: 'gpt-5.4-mini', keyHint: 'abcd2' }),
      )
    })
    expect(secrets.get('ai-api-key:b')).toBe('sk-openai-secret')
  })

  it('traps Tab inside the dialog', async () => {
    await renderSection()
    await expect.element(page.getByText(/No AI providers configured/)).toBeInTheDocument()

    const dialog = await openDialog()
    const submitButton = dialog.getByRole('button', { name: 'Add provider' })
    submitButton.element().focus()
    await userEvent.keyboard('{Tab}')

    // From the last control, Tab wraps to the first instead of escaping
    // into the settings page behind the modal. Base UI traps by letting Tab
    // land on a sentinel guard span for a beat, then teleporting focus to
    // the wrap target — poll for the settled state, not the interim one
    // (WebKit reliably exposes the interim beat).
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(
        dialog.getByLabelText('Provider', { exact: true }).element(),
      )
    })
  })

  it('returns focus to the opener when the dialog closes', async () => {
    await renderSection()
    await expect.element(page.getByText(/No AI providers configured/)).toBeInTheDocument()

    // WebKit does not focus buttons on click, so anchor focus explicitly:
    // both engines then open the dialog with the opener as the previously
    // focused element, which Base UI restores after the popup unmounts.
    const opener = page.getByRole('button', { name: /add provider/i })
    opener.element().focus()
    const dialog = await openDialog()

    await dialog.getByRole('button', { name: 'Cancel' }).click()
    // The restore runs in a microtask after the popup unmounts; poll for it.
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(opener.element())
    })
  })

  it('falls back to the first entry when the default id dangles', async () => {
    stored = { ...twoStoredModels(), defaultAiProviderId: 'gone' }
    await renderSection()

    await expect.element(page.getByText('Default', { exact: true })).toBeInTheDocument()
    // The badge lands on the first row; the second still offers "Make default".
    await expect.element(page.getByRole('button', { name: 'Make default' })).toBeInTheDocument()
  })
})

describe('AiProvidersSection on this Mac', () => {
  const OLLAMA_URL = 'http://localhost:11434/v1'
  const ATTESTATION = { baseUrl: OLLAMA_URL, model: 'llama3.2' }

  /** A stored OpenAI-compatible entry on Ollama's default endpoint. */
  function local(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'ollama',
      provider: 'openai-compatible',
      model: 'llama3.2',
      baseUrl: OLLAMA_URL,
      keyHint: '',
      ...overrides,
    }
  }

  function onDeviceSwitch(): Locator {
    return page.getByRole('switch', { name: 'Runs on this Mac' })
  }

  function badge(): Locator {
    return page.getByText('On this Mac · llama3.2')
  }

  it('offers the switch in the add form only for an endpoint on this Mac', async () => {
    await renderSection()
    await expect.element(page.getByText(/No AI providers configured/)).toBeInTheDocument()

    const dialog = await openDialog()
    await dialog.getByRole('combobox', { name: 'Provider' }).click()
    await page.getByRole('option', { name: 'OpenAI-compatible' }).click()
    await dialog.getByLabelText('Endpoint base URL').fill('http://192.168.1.5:1234/v1')
    await expect.element(dialog.getByRole('switch', { name: 'Runs on this Mac' })).toBeDisabled()
    await expect
      .element(dialog.getByText('Only for localhost, 127.x.x.x or [::1]'))
      .toBeInTheDocument()

    await dialog.getByRole('button', { name: 'Ollama' }).click()
    await expect.element(dialog.getByLabelText('Endpoint base URL')).toHaveValue(OLLAMA_URL)
    await expect.element(dialog.getByRole('switch', { name: 'Runs on this Mac' })).toBeEnabled()
    await dialog.getByLabelText('Default model').fill('llama3.2')
    await dialog.getByRole('switch', { name: 'Runs on this Mac' }).click()
    // What the switch means is spelled out, naming the model and endpoint.
    const meaning = dialog.getByText(/as running on this Mac/)
    await expect
      .element(meaning)
      .toMatchTextContent(`Reflect will treat llama3.2 at ${OLLAMA_URL} as running on this Mac.`)
    expect(meaning.element().textContent).not.toMatch(/never/i)
    await dialog.getByRole('checkbox', { name: 'Can read images' }).click()
    await dialog.getByLabelText('Context length (tokens)').fill('32,768')
    await dialog.getByRole('button', { name: 'Add provider' }).click()

    await vi.waitFor(() => expect(saved).toHaveLength(1))
    expect(lastSavedDoc().aiProviders[0]).toMatchObject({
      baseUrl: OLLAMA_URL,
      model: 'llama3.2',
      onDevice: ATTESTATION,
      supportsImages: true,
      contextWindow: 32_768,
    })
  })

  it('turns on only after a dialog that names the endpoint and model, and off at once', async () => {
    stored = { aiProviders: [local()], defaultAiProviderId: 'ollama' }
    await renderSection()
    await expect.element(onDeviceSwitch()).not.toBeChecked()

    await onDeviceSwitch().click()
    const confirm = page.getByRole('dialog', { name: 'Treat this model as running on this Mac?' })
    await expect.element(confirm).toMatchTextContent(/llama3\.2 at http:\/\/localhost:11434\/v1/)
    await expect.element(confirm).toMatchTextContent(/no proxy and no redirects/)
    expect(confirm.element().textContent).not.toMatch(/never/i)
    await confirm.getByRole('button', { name: 'Cancel' }).click()
    await expectLocatorToHaveCount(page.getByRole('dialog'), 0)
    await expect.element(onDeviceSwitch()).not.toBeChecked()
    expect(saved).toEqual([])

    await onDeviceSwitch().click()
    await page.getByRole('button', { name: 'Turn on' }).click()
    await vi.waitFor(() =>
      expect(lastSavedDoc().aiProviders[0]).toMatchObject({ onDevice: ATTESTATION }),
    )
    await expect.element(onDeviceSwitch()).toBeChecked()
    await expect.element(badge()).toBeInTheDocument()

    await onDeviceSwitch().click()
    await vi.waitFor(() => expect(lastSavedDoc().aiProviders[0]).toMatchObject({ onDevice: null }))
    await expectLocatorToHaveCount(page.getByRole('dialog'), 0)
    await expectLocatorToHaveCount(badge(), 0)
  })

  it('drops the badge when the row changes its default model', async () => {
    stored = { aiProviders: [local({ onDevice: ATTESTATION })], defaultAiProviderId: 'ollama' }
    await renderSection()
    await expect.element(badge()).toBeInTheDocument()

    await page.getByRole('combobox', { name: 'Default model for OpenAI-compatible' }).click()
    await page.getByRole('option', { name: /Local model/ }).click()

    await vi.waitFor(() =>
      expect(lastSavedDoc().aiProviders[0]).toMatchObject({
        model: 'local-model',
        onDevice: null,
      }),
    )
    await expectLocatorToHaveCount(badge(), 0)
    await expect.element(onDeviceSwitch()).not.toBeChecked()
  })

  it('asks to re-confirm an attestation a hand edit no longer matches', async () => {
    stored = {
      aiProviders: [local({ onDevice: { baseUrl: OLLAMA_URL, model: 'llama3.1' } })],
      defaultAiProviderId: 'ollama',
    }
    await renderSection()

    await expect
      .element(page.getByRole('alert'))
      .toMatchTextContent('Re-confirm: endpoint or model changed')
    await expect.element(onDeviceSwitch()).not.toBeChecked()
    await expectLocatorToHaveCount(page.getByText(/On this Mac ·/), 0)
  })

  it('keeps the switch off for an endpoint off this Mac', async () => {
    stored = {
      aiProviders: [local({ baseUrl: 'http://192.168.1.5:11434/v1' })],
      defaultAiProviderId: 'ollama',
    }
    await renderSection()

    await expect.element(onDeviceSwitch()).toBeDisabled()
    await expect
      .element(page.getByText('Only for localhost, 127.x.x.x or [::1]'))
      .toBeInTheDocument()
  })

  it('stores image support and a context length from the row', async () => {
    stored = { aiProviders: [local()], defaultAiProviderId: 'ollama' }
    await renderSection()

    await page.getByRole('checkbox', { name: 'Can read images' }).click()
    await vi.waitFor(() =>
      expect(lastSavedDoc().aiProviders[0]).toMatchObject({ supportsImages: true }),
    )

    const contextLength = page.getByLabelText('Context length (tokens)')
    await contextLength.fill('100')
    await userEvent.keyboard('{Enter}')
    await expect.element(page.getByRole('alert')).toMatchTextContent(/at least 2,048 tokens/)
    expect(lastSavedDoc().aiProviders[0]).not.toMatchObject({ contextWindow: 100 })

    await contextLength.fill('16384')
    await userEvent.keyboard('{Enter}')
    await vi.waitFor(() =>
      expect(lastSavedDoc().aiProviders[0]).toMatchObject({ contextWindow: 16_384 }),
    )
    await expectLocatorToHaveCount(page.getByRole('alert'), 0)
  })
})
