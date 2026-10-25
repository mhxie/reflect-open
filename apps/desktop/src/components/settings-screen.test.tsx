import { QueryClient } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import type { Locator } from 'vitest/browser'
import {
  DEFAULT_SETTINGS,
  type CoreServices,
  type GraphSessionService,
  type OllamaModels,
  type Settings,
} from '@reflect/core'
import {
  createTestCoreServices,
  createTestEmbeddingRuntimeService,
  createTestPlatformService,
  createTestGitSyncService,
  type TestEmbeddingRuntimeService,
  type TestOpenGraph,
} from '@reflect/core/testing'
import { formatFullDate } from '@/lib/dates.ts'
import { NoteTemplatesProvider } from '@/providers/note-templates-provider.tsx'
import { ShortcutsProvider } from '@/providers/shortcuts-provider.tsx'
import { UpdateProvider } from '@/providers/update-provider.tsx'
import { V1ImportProvider } from '@/providers/v1-import-provider.tsx'
import { expectLocatorToHaveCount } from '@/test-utils/expect.ts'
import { act } from '@/test-utils/act.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { ShortcutsDialog } from './shortcuts-dialog.tsx'
import { SettingsScreen } from './settings-screen.tsx'

// What the app starts from; each test sets them before `renderScreen`.
let stored: Partial<Settings>
let openGraph: TestOpenGraph
let embedRuntime: TestEmbeddingRuntimeService
// What the Ollama server on this Mac reports to the summary model picker.
let ollamaModels: OllamaModels

// The services of the rendered app; set by `renderScreen`.
let app: ReturnType<typeof createApp>
let forget: MockInstance<GraphSessionService['forgetRecent']>
let deleteGraph: MockInstance<GraphSessionService['deleteGraph']>
let listOllamaModels: MockInstance<CoreServices['onDeviceModels']['listOllamaModels']>

/**
 * Every settings document the app persisted, oldest first.
 */
function saved(): Settings[] {
  return app.settings.saves()
}

// The screen runs off macOS desktop (no Agents, iCloud or Calendar rows), with
// a graph open and its git sync disconnected.
function createApp() {
  return createTestCoreServices({
    database: createWasmTestDatabaseService(),
    embeddingRuntime: embedRuntime,
    platform: createTestPlatformService({ isMacosDesktop: false, hasMacosTitleBarOverlay: false }),
    gitSync: createTestGitSyncService({ state: { phase: 'disconnected' } }),
  })
}

async function renderScreen() {
  app = createApp()
  forget = vi.spyOn(app.graphSession, 'forgetRecent').mockResolvedValue()
  deleteGraph = vi.spyOn(app.graphSession, 'deleteGraph').mockResolvedValue()
  listOllamaModels = vi
    .spyOn(app.onDeviceModels, 'listOllamaModels')
    .mockImplementation(() => Promise.resolve(ollamaModels))
  // The Wiki section's trust report row: no report written yet.
  app.ipc.onCommand('wiki_trust_report_read', () => null)
  return await renderInApp(
    <>
      <SettingsScreen />
      <ShortcutsDialog />
    </>,
    {
      app,
      graph: openGraph,
      settings: stored,
      queryClient: new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: Infinity } },
      }),
      // The Note templates section shares the "New template" dialog state
      // (templates provider). The Import section hands the picked zip to the
      // workspace's V1 import.
      wrapper: (children) => (
        <UpdateProvider autoCheck={false}>
          <ShortcutsProvider>
            <NoteTemplatesProvider>
              <V1ImportProvider>{children}</V1ImportProvider>
            </NoteTemplatesProvider>
          </ShortcutsProvider>
        </UpdateProvider>
      ),
    },
  )
}

function radio(name: RegExp): Locator {
  return page.getByRole('radio', { name })
}

/**
 * Clicks a radio's option card — the `<input>` itself is `sr-only`.
 */
async function pickRadio(name: RegExp): Promise<void> {
  const label = radio(name).element().closest('label')
  if (!(label instanceof HTMLLabelElement)) {
    throw new TypeError('expected the radio to sit inside its option card')
  }
  await userEvent.click(label)
}

beforeEach(() => {
  stored = {}
  openGraph = { root: '/graphs/work', name: 'Work', generation: 1, indexGeneration: 7 }
  embedRuntime = createTestEmbeddingRuntimeService({ status: { status: 'uninitialized' } })
  ollamaModels = { kind: 'unreachable' }
})

afterEach(() => {
  vi.useRealTimers()
})

describe('SettingsScreen', () => {
  it('shows update controls when the native bridge is available', async () => {
    await renderScreen()
    await expect
      .element(page.getByRole('button', { name: /check for updates/i }))
      .toBeInTheDocument()
  })

  it('persists the default-on transcription auto-format preference', async () => {
    await renderScreen()
    const toggle = page.getByRole('switch', { name: /transcription auto-format/i })
    await expect.element(toggle).toHaveAttribute('aria-checked', 'true')
    const descriptionId = toggle.element().getAttribute('aria-describedby')
    expect(descriptionId).not.toBeNull()
    expect(document.getElementById(descriptionId ?? '')?.textContent).toContain(
      'Use AI to add punctuation, paragraphs, and light Markdown',
    )

    await toggle.click()

    await expect.element(toggle).toHaveAttribute('aria-checked', 'false')
    await vi.waitFor(() => expect(saved().at(-1)).toMatchObject({ transcriptionFormat: false }))
  })

  it('reflects a persisted transcription auto-format opt-out', async () => {
    stored = { transcriptionFormat: false }
    await renderScreen()

    const toggle = page.getByRole('switch', { name: /transcription auto-format/i })
    await expect.element(toggle).toHaveAttribute('aria-checked', 'false')
  })

  it('reflects and persists the transcription helper text', async () => {
    stored = { transcriptionPrompt: 'Ocavue' }
    await renderScreen()
    const textarea = page.getByRole('textbox', { name: 'Transcription helper text' })
    await expect.element(textarea).toHaveValue('Ocavue')

    await textarea.fill('  Names:\nOcavue  ')
    await userEvent.tab()

    await vi.waitFor(() => {
      expect(saved().at(-1)).toMatchObject({ transcriptionPrompt: 'Names:\nOcavue' })
    })
  })

  it('clears the transcription helper text', async () => {
    stored = { transcriptionPrompt: 'Ocavue' }
    await renderScreen()
    const section = page.getByRole('region', { name: 'Audio memos' })

    await section.getByRole('button', { name: 'Clear' }).click()

    await vi.waitFor(() => expect(saved().at(-1)).toMatchObject({ transcriptionPrompt: '' }))
  })

  it('warns when the transcription helper text is over the limit and truncates on save', async () => {
    await renderScreen()
    const textarea = page.getByRole('textbox', { name: 'Transcription helper text' })

    await textarea.fill('x'.repeat(510))

    await expect.element(textarea).toHaveAttribute('aria-invalid', 'true')
    await expect
      .element(page.getByRole('alert'))
      .toMatchTextContent('10 characters over the 500-character limit')

    await userEvent.tab()

    await vi.waitFor(() => {
      expect(saved().at(-1)).toMatchObject({ transcriptionPrompt: 'x'.repeat(500) })
    })
  })

  it('picks several spoken languages and persists them in order', async () => {
    await renderScreen()
    const trigger = page.getByRole('combobox', { name: 'Spoken languages' })
    await expect.element(trigger).toMatchTextContent('Any language')

    await trigger.click()
    await page.getByRole('option', { name: 'English' }).click()
    await page.getByRole('option', { name: 'Chinese' }).click()

    await expect.element(trigger).toMatchTextContent('English, Chinese')
    await vi.waitFor(() => {
      expect(saved().at(-1)).toMatchObject({ transcriptionLanguages: ['en', 'zh'] })
    })

    await page.getByRole('option', { name: 'English' }).click()

    await expect.element(trigger).toMatchTextContent('Chinese')
    await vi.waitFor(() => expect(saved().at(-1)).toMatchObject({ transcriptionLanguages: ['zh'] }))
  })

  it('reflects the spoken language an earlier version stored', async () => {
    stored = { transcriptionLanguage: 'zh' }
    await renderScreen()

    await expect
      .element(page.getByRole('combobox', { name: 'Spoken languages' }))
      .toMatchTextContent('Chinese')
  })

  it('confirms before forgetting the open graph from saved graphs', async () => {
    await renderScreen()

    const section = page.getByRole('region', { name: 'Danger zone' })
    await section.getByRole('button', { name: /forget graph/i }).click()

    const dialog = page.getByRole('dialog', { name: /forget graph/i })
    await expect.element(dialog.getByText('/graphs/work')).toBeInTheDocument()
    expect(forget).not.toHaveBeenCalled()

    await dialog.getByRole('button', { name: /forget graph/i }).click()

    await vi.waitFor(() => expect(forget).toHaveBeenCalledWith('/graphs/work'))
  })

  it('requires typing the graph name before deleting the graph', async () => {
    await renderScreen()

    const section = page.getByRole('region', { name: 'Danger zone' })
    await section.getByRole('button', { name: /delete graph/i }).click()

    const dialog = page.getByRole('dialog', { name: /delete graph/i })
    await expect.element(dialog.getByText('/graphs/work')).toBeInTheDocument()
    // Deleting an adopted vault trashes the user's own folder — the dialog
    // must say so in as many words.
    await expect.element(dialog.getByText(/everything inside it to Trash/)).toBeInTheDocument()
    const confirm = dialog.getByRole('button', { name: /delete graph/i })
    await expect.element(confirm).toBeDisabled()

    const nameInput = dialog.getByLabelText('Graph name')
    await nameInput.fill('Wor')
    await expect.element(confirm).toBeDisabled()
    // Enter with a mismatched name must not delete either.
    await userEvent.keyboard('{Enter}')
    expect(deleteGraph).not.toHaveBeenCalled()

    await nameInput.fill('Work')
    await expect.element(confirm).not.toBeDisabled()
    await confirm.click()

    await vi.waitFor(() => expect(deleteGraph).toHaveBeenCalledTimes(1))
  })

  it('reflects the persisted markdown syntax mode', async () => {
    stored = { editorMarkdownSyntax: 'show' }
    await renderScreen()
    await expect.element(radio(/^show/i)).toBeChecked()
    await expect.element(radio(/^hide/i)).not.toBeChecked()
  })

  it('selecting Show applies instantly and persists', async () => {
    await renderScreen()
    await expect.element(radio(/^hide/i)).toBeChecked()

    await pickRadio(/^show/i)

    await vi.waitFor(() => {
      expect(saved()).toEqual([
        {
          ...DEFAULT_SETTINGS,
          editorMarkdownSyntax: 'show',
        },
      ])
    })
    await expect.element(radio(/^show/i)).toBeChecked()
    await expect.element(radio(/^hide/i)).not.toBeChecked()
  })

  it('reflects the persisted text size', async () => {
    stored = { editorTextSize: 'large' }
    await renderScreen()
    await expect.element(radio(/^large/i)).toBeChecked()
    await expect.element(radio(/^medium/i)).not.toBeChecked()
  })

  it('selecting Large applies instantly and persists the text size', async () => {
    await renderScreen()
    await expect.element(radio(/^small/i)).toBeChecked()

    await pickRadio(/^large/i)

    await vi.waitFor(() => {
      expect(saved()).toEqual([
        {
          ...DEFAULT_SETTINGS,
          editorTextSize: 'large',
        },
      ])
    })
    await expect.element(radio(/^large/i)).toBeChecked()
    await expect.element(radio(/^medium/i)).not.toBeChecked()
  })

  it('enables full-width notes instantly and persists the preference', async () => {
    await renderScreen()
    const toggle = page.getByRole('switch', { name: /full-width notes/i })
    await expect.element(toggle).toHaveAttribute('aria-checked', 'false')

    await toggle.click()

    await expect.element(toggle).toHaveAttribute('aria-checked', 'true')
    await vi.waitFor(() => expect(saved().at(-1)).toMatchObject({ editorFullWidth: true }))
  })

  it('reflects a persisted spell check opt-out', async () => {
    stored = { editorSpellCheck: false }
    await renderScreen()
    const toggle = page.getByRole('switch', { name: /spell check/i })
    await expect.element(toggle).toHaveAttribute('aria-checked', 'false')
  })

  it('toggling spell check off applies instantly and persists', async () => {
    await renderScreen()
    const toggle = page.getByRole('switch', { name: /spell check/i })
    // On by default.
    await expect.element(toggle).toHaveAttribute('aria-checked', 'true')

    await toggle.click()

    await expect.element(toggle).toHaveAttribute('aria-checked', 'false')
    await vi.waitFor(() => {
      expect(saved()).toEqual([
        {
          ...DEFAULT_SETTINGS,
          editorSpellCheck: false,
        },
      ])
    })
  })

  it('reflects a persisted smooth caret animation opt-out', async () => {
    stored = { editorSmoothCaretAnimation: false }
    await renderScreen()
    const toggle = page.getByRole('switch', { name: /smooth caret animation/i })
    await expect.element(toggle).toHaveAttribute('aria-checked', 'false')
  })

  it('disables smooth caret animation instantly and persists the preference', async () => {
    await renderScreen()
    const toggle = page.getByRole('switch', { name: /smooth caret animation/i })
    await expect.element(toggle).toHaveAttribute('aria-checked', 'true')

    await toggle.click()

    await expect.element(toggle).toHaveAttribute('aria-checked', 'false')
    await vi.waitFor(() => {
      expect(saved().at(-1)).toMatchObject({ editorSmoothCaretAnimation: false })
    })
  })

  it('reflects a persisted default-bullet opt-out', async () => {
    stored = { editorDefaultBullet: false }
    await renderScreen()
    const toggle = page.getByRole('switch', { name: /start with a bullet/i })
    await expect.element(toggle).toHaveAttribute('aria-checked', 'false')
  })

  it('toggling the default bullet off applies instantly and persists', async () => {
    await renderScreen()
    const toggle = page.getByRole('switch', { name: /start with a bullet/i })
    // On by default.
    await expect.element(toggle).toHaveAttribute('aria-checked', 'true')

    await toggle.click()

    await expect.element(toggle).toHaveAttribute('aria-checked', 'false')
    await vi.waitFor(() => {
      expect(saved()).toEqual([
        {
          ...DEFAULT_SETTINGS,
          editorDefaultBullet: false,
        },
      ])
    })
  })

  it('reflects a persisted bullet-after-heading opt-out', async () => {
    stored = { editorBulletAfterHeading: false }
    await renderScreen()
    const toggle = page.getByRole('switch', { name: /bullet after a heading/i })
    await expect.element(toggle).toHaveAttribute('aria-checked', 'false')
  })

  it('toggling bullet-after-heading off persists independently of the seed bullet', async () => {
    await renderScreen()
    const toggle = page.getByRole('switch', { name: /bullet after a heading/i })
    await expect.element(toggle).toHaveAttribute('aria-checked', 'true')

    await toggle.click()

    await expect.element(toggle).toHaveAttribute('aria-checked', 'false')
    await vi.waitFor(() => {
      expect(saved()).toEqual([
        {
          ...DEFAULT_SETTINGS,
          editorBulletAfterHeading: false,
        },
      ])
    })
  })

  it('reflects the persisted theme and persists a new choice', async () => {
    stored = { theme: 'dark' }
    await renderScreen()
    await expect.element(radio(/^dark/i)).toBeChecked()

    await pickRadio(/^light/i)

    await expect.element(radio(/^light/i)).toBeChecked()
    await vi.waitFor(() => {
      expect(saved()).toEqual([
        {
          ...DEFAULT_SETTINGS,
          theme: 'light',
        },
      ])
    })
  })

  it('reflects the persisted date format', async () => {
    stored = { dateFormat: 'dmy' }
    await renderScreen()
    const trigger = page.getByRole('combobox', { name: 'Date format' })
    // The options label themselves with today's date in each order.
    await expect.element(trigger).toMatchTextContent(formatFullDate(new Date(), 'dmy'))
  })

  it('selecting day-month-year persists the date format', async () => {
    await renderScreen()
    const trigger = page.getByRole('combobox', { name: 'Date format' })
    await expect.element(trigger).toMatchTextContent(formatFullDate(new Date(), 'mdy'))

    await trigger.click()
    await page.getByRole('option', { name: formatFullDate(new Date(), 'dmy') }).click()

    await expect.element(trigger).toMatchTextContent(formatFullDate(new Date(), 'dmy'))
    await vi.waitFor(() => {
      expect(saved()).toEqual([
        {
          ...DEFAULT_SETTINGS,
          dateFormat: 'dmy',
        },
      ])
    })
  })

  it('selecting ISO persists the date format', async () => {
    const now = new Date(2026, 5, 10, 12, 0, 0)
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(now)

    await renderScreen()
    const trigger = page.getByRole('combobox', { name: 'Date format' })
    const isoLabel = formatFullDate(now, 'iso')
    await expect.element(trigger).toMatchTextContent(formatFullDate(now, 'mdy'))

    await trigger.click()
    await page.getByRole('option', { name: isoLabel }).click()

    await expect.element(trigger).toMatchTextContent(isoLabel)
    await vi.waitFor(() => {
      expect(saved()).toEqual([
        {
          ...DEFAULT_SETTINGS,
          dateFormat: 'iso',
        },
      ])
    })
  })

  it('shows the week start setting in Date & time', async () => {
    await renderScreen()
    const dateTime = page.getByRole('region', { name: 'Date & time' })
    const appearance = page.getByRole('region', { name: 'Appearance' })

    await expect
      .element(dateTime.getByRole('combobox', { name: 'Start week on' }))
      .toBeInTheDocument()
    expect(appearance.getByRole('combobox', { name: 'Start week on' }).query()).toBeNull()
  })

  it('toggling the activity heatmap off persists', async () => {
    await renderScreen()
    const toggle = page.getByRole('switch', { name: /activity heatmap/i })
    await expect.element(toggle).toHaveAttribute('aria-checked', 'true')

    await toggle.click()

    await expect.element(toggle).toHaveAttribute('aria-checked', 'false')
    await vi.waitFor(() => expect(saved().at(-1)).toMatchObject({ activityHeatmapEnabled: false }))
  })

  it('toggling the status bar off persists', async () => {
    await renderScreen()
    const toggle = page.getByRole('switch', { name: /status bar/i })
    await expect.element(toggle).toHaveAttribute('aria-checked', 'true')

    await toggle.click()

    await expect.element(toggle).toHaveAttribute('aria-checked', 'false')
    await vi.waitFor(() => expect(saved().at(-1)).toMatchObject({ statusBarEnabled: false }))
  })

  it('selecting Sunday persists the week start day', async () => {
    await renderScreen()
    const trigger = page.getByRole('combobox', { name: 'Start week on' })
    await expect.element(trigger).toMatchTextContent('Monday')

    await trigger.click()
    await page.getByRole('option', { name: 'Sunday' }).click()

    await expect.element(trigger).toMatchTextContent('Sunday')
    await vi.waitFor(() => {
      expect(saved()).toEqual([
        {
          ...DEFAULT_SETTINGS,
          weekStartDay: 'sunday',
        },
      ])
    })
  })

  it('selecting Saturday persists the week start day', async () => {
    await renderScreen()
    const trigger = page.getByRole('combobox', { name: 'Start week on' })
    await trigger.click()
    await page.getByRole('option', { name: 'Saturday' }).click()

    await expect.element(trigger).toMatchTextContent('Saturday')
    await vi.waitFor(() => expect(saved().at(-1)).toMatchObject({ weekStartDay: 'saturday' }))
  })

  it('reflects the persisted time format', async () => {
    stored = { timeFormat: '24h' }
    await renderScreen()
    const trigger = page.getByRole('combobox', { name: 'Time format' })
    await expect.element(trigger).toMatchTextContent('24-hour')
  })

  it('selecting 24-hour persists the time format', async () => {
    await renderScreen()
    const trigger = page.getByRole('combobox', { name: 'Time format' })
    await expect.element(trigger).toMatchTextContent('12-hour')

    await trigger.click()
    await page.getByRole('option', { name: '24-hour' }).click()

    await expect.element(trigger).toMatchTextContent('24-hour')
    await vi.waitFor(() => {
      expect(saved()).toEqual([
        {
          ...DEFAULT_SETTINGS,
          timeFormat: '24h',
        },
      ])
    })
  })

  it('summarizes on this Mac by default and says how to get a model', async () => {
    await renderScreen()
    const trigger = page.getByRole('combobox', { name: 'AI summaries' })
    await expect.element(trigger).toMatchTextContent('On this Mac')
    await expect.element(page.getByText(/Ollama isn’t running on this Mac/)).toBeInTheDocument()
    ollamaModels = { kind: 'ok', models: [] }
    const looks = listOllamaModels.mock.calls.length
    await page.getByRole('button', { name: 'Check again' }).click()
    await vi.waitFor(() => expect(listOllamaModels.mock.calls.length).toBe(looks + 1))

    await trigger.click()
    await page.getByRole('option', { name: 'Off · show the opening text' }).click()
    await trigger.click()
    await page.getByRole('option', { name: 'On this Mac' }).click()
    await expect
      .element(page.getByText(/Ollama has no models yet\. Pull one in Terminal/))
      .toBeInTheDocument()
    await expect.element(page.getByText('ollama pull qwen3')).toBeInTheDocument()

    await trigger.click()
    await page.getByRole('option', { name: 'Cloud provider' }).click()
    await expect
      .element(
        page.getByText(
          'Add an OpenAI, Anthropic, Google, or OpenAI-compatible provider in AI providers to start summarizing.',
        ),
      )
      .toBeInTheDocument()
    // Nothing to agree to without a provider.
    await expect
      .element(page.getByRole('button', { name: 'Start summarizing' }))
      .not.toBeInTheDocument()
    await vi.waitFor(() => expect(saved().at(-1)).toMatchObject({ aiSummaries: 'cloud' }))
  })

  it('sets up an Ollama model for summaries once the user confirms it runs here', async () => {
    ollamaModels = {
      kind: 'ok',
      models: [
        { name: 'gemma4:31b', parameterSize: '31.0B' },
        { name: 'qwen3.8:27b', parameterSize: '27.4B' },
      ],
    }
    await renderScreen()
    await expect.element(page.getByText('Choose a model to start summarizing.')).toBeInTheDocument()

    await page.getByRole('combobox', { name: 'Summary model' }).click()
    await page.getByRole('option', { name: 'qwen3.8:27b · 27.4B' }).click()
    await expect
      .element(page.getByText('Treat this model as running on this Mac?'))
      .toBeInTheDocument()
    await page.getByRole('button', { name: 'Turn on' }).click()

    await vi.waitFor(() => {
      const document = saved().at(-1)
      expect(document?.aiProviders).toEqual([
        expect.objectContaining({
          provider: 'openai-compatible',
          model: 'qwen3.8:27b',
          baseUrl: 'http://localhost:11434/v1',
          onDevice: {
            model: 'qwen3.8:27b',
            baseUrl: 'http://localhost:11434/v1',
            server: 'ollama',
          },
        }),
      ])
      expect(document?.aiSummariesLocalModel).toEqual({
        configId: document?.aiProviders[0]?.id,
        modelId: 'qwen3.8:27b',
      })
    })
    await expect
      .element(page.getByRole('combobox', { name: 'Summary model' }))
      .toMatchTextContent('qwen3.8:27b · Ollama')
  })

  it('picks the model already set up on this Mac instead of adding another entry', async () => {
    const gemma = {
      id: 'gemma',
      provider: 'openai-compatible',
      model: 'gemma4:26b',
      baseUrl: 'http://localhost:11434/v1',
      keyHint: '',
      onDevice: { model: 'gemma4:26b', baseUrl: 'http://localhost:11434/v1', server: 'ollama' },
    }
    stored = { aiProviders: [gemma], defaultAiProviderId: 'gemma' } as Partial<Settings>
    ollamaModels = {
      kind: 'ok',
      models: [
        { name: 'gemma4:26b', parameterSize: '25.8B' },
        { name: 'qwen3.8:27b', parameterSize: '27.4B' },
      ],
    }
    await renderScreen()
    const picker = page.getByRole('combobox', { name: 'Summary model' })
    await expect.element(picker).toMatchTextContent('gemma4:26b · Ollama')

    await picker.click()
    // Set up once, listed once.
    await expectLocatorToHaveCount(page.getByRole('option', { name: /^gemma4:26b/ }), 1)
    await page.getByRole('option', { name: 'gemma4:26b · Ollama' }).click()

    await vi.waitFor(() => {
      expect(saved().at(-1)).toMatchObject({
        aiProviders: [gemma],
        aiSummariesLocalModel: { configId: 'gemma', modelId: 'gemma4:26b' },
      })
    })
  })

  it('asks for the go-ahead once a cloud provider is set up, pinning the model', async () => {
    stored = {
      aiProviders: [
        { id: 'cloud', provider: 'anthropic', model: 'claude-opus-4-8', keyHint: 'wxyz1' },
      ],
      defaultAiProviderId: 'cloud',
      aiSummaries: 'cloud',
    }
    await renderScreen()
    await expect
      .element(page.getByRole('combobox', { name: 'AI summaries' }))
      .toMatchTextContent('Cloud provider')
    await expect
      .element(page.getByText(/Private notes are never sent and keep their opening text/))
      .toBeInTheDocument()
    await expect
      .element(page.getByRole('combobox', { name: 'Summary provider' }))
      .toMatchTextContent('Anthropic · ·····wxyz1')
    // The default provider's small model until the user picks another.
    await expect
      .element(page.getByRole('combobox', { name: 'Summary model' }))
      .toMatchTextContent('Claude Haiku 4.5')

    await page.getByRole('button', { name: 'Start summarizing' }).click()

    const haiku = { configId: 'cloud', modelId: 'claude-haiku-4-5' }
    await vi.waitFor(() => {
      expect(saved().at(-1)).toMatchObject({
        aiSummaries: 'cloud',
        aiSummariesCloudModel: haiku,
        aiSummariesCloudConsent: haiku,
      })
    })
    // The flag earlier builds read alone is never set: they'd send to their own
    // default provider on the strength of it.
    expect(saved().at(-1)).toHaveProperty('aiSummariesCloudConfirmed', false)
    await expect
      .element(page.getByRole('button', { name: 'Start summarizing' }))
      .not.toBeInTheDocument()
  })

  it('asks again for any model but the one agreed to', async () => {
    const haiku = { configId: 'cloud', modelId: 'claude-haiku-4-5' }
    stored = {
      aiProviders: [
        { id: 'cloud', provider: 'anthropic', model: 'claude-opus-4-8', keyHint: 'wxyz1' },
        { id: 'work', provider: 'openai', model: 'gpt-6.1-sol', keyHint: 'abcde' },
      ],
      defaultAiProviderId: 'cloud',
      aiSummaries: 'cloud',
      aiSummariesCloudModel: haiku,
      aiSummariesCloudConsent: haiku,
    }
    await renderScreen()
    await expect
      .element(page.getByRole('button', { name: 'Start summarizing' }))
      .not.toBeInTheDocument()

    await page.getByRole('combobox', { name: 'Summary provider' }).click()
    await page.getByRole('option', { name: 'OpenAI · ·····abcde' }).click()

    await vi.waitFor(() => {
      expect(saved().at(-1)).toMatchObject({
        aiSummariesCloudModel: { configId: 'work', modelId: 'gpt-5.4-nano' },
        aiSummariesCloudConsent: haiku,
      })
    })
    await expect
      .element(page.getByRole('button', { name: 'Start summarizing' }))
      .toBeInTheDocument()
  })

  it('asks for another model on the agreed entry, and over an earlier build’s go-ahead', async () => {
    stored = {
      aiProviders: [
        { id: 'cloud', provider: 'anthropic', model: 'claude-opus-4-8', keyHint: 'wxyz1' },
      ],
      defaultAiProviderId: 'cloud',
      aiSummaries: 'cloud',
      aiSummariesCloudModel: { configId: 'cloud', modelId: 'claude-sonnet-5-5' },
      aiSummariesCloudConsent: { configId: 'cloud', modelId: 'claude-haiku-4-5' },
      // An earlier build's go-ahead named no model and grants nothing here.
      aiSummariesCloudConfirmed: true,
    }
    await renderScreen()
    await page.getByRole('button', { name: 'Start summarizing' }).click()

    const sonnet = { configId: 'cloud', modelId: 'claude-sonnet-5-5' }
    await vi.waitFor(() => {
      expect(saved().at(-1)).toMatchObject({
        aiSummariesCloudModel: sonnet,
        aiSummariesCloudConsent: sonnet,
        // Left as that build wrote it.
        aiSummariesCloudConfirmed: true,
      })
    })
  })

  it('names the on-device default instead of asking for a provider the user has', async () => {
    stored = {
      aiProviders: [
        {
          id: 'ollama',
          provider: 'openai-compatible',
          model: 'llama:latest',
          baseUrl: 'http://localhost:11434/v1',
          keyHint: '',
          onDevice: {
            model: 'llama:latest',
            baseUrl: 'http://localhost:11434/v1',
            server: 'ollama',
          },
        },
        { id: 'cloud', provider: 'anthropic', model: 'claude-opus-4-8', keyHint: 'wxyz1' },
      ],
      defaultAiProviderId: 'ollama',
      aiSummaries: 'cloud',
    }
    await renderScreen()
    await expect
      .element(
        page.getByText(
          'Your default AI provider runs on this Mac. Choose a cloud provider, or On this Mac.',
        ),
      )
      .toBeInTheDocument()
    await expect
      .element(page.getByRole('button', { name: 'Start summarizing' }))
      .not.toBeInTheDocument()
  })

  it('adds an All Notes filter tag, normalized, and persists it', async () => {
    await renderScreen()
    const input = page.getByLabelText('Add filter tag')

    await input.fill(' #Meeting ')
    await page.getByRole('button', { name: 'Pin #meeting', exact: true }).click()

    await expect.element(page.getByText('#meeting', { exact: true })).toBeInTheDocument()
    await vi.waitFor(() => {
      expect(saved()).toEqual([
        {
          ...DEFAULT_SETTINGS,
          allNotesFilterTags: ['book', 'link', 'person', 'meeting'],
        },
      ])
    })
  })

  it('rejects a tag name outside the #tag grammar with an inline error', async () => {
    await renderScreen()
    const input = page.getByLabelText('Add filter tag')

    await input.fill('my tag')
    await expect.element(page.getByRole('button', { name: 'Pin tag', exact: true })).toBeDisabled()

    await expect.element(page.getByRole('alert')).toMatchTextContent(`"my tag" can't be a tag`)
    // The draft stays put for fixing, and nothing reaches the store.
    await expect.element(input).toHaveValue('my tag')
    await vi.waitFor(() => expect(saved()).toEqual([]))
  })

  it('ignores adding a duplicate filter tag', async () => {
    stored = { allNotesFilterTags: ['book'] }
    await renderScreen()
    // Defaults render before the disk document lands — wait for hydration
    // (the stored list has no `person`) so the click edits the loaded list.
    await expectLocatorToHaveCount(page.getByText('#person'), 0)
    await expect.element(page.getByText('#book')).toBeInTheDocument()

    await page.getByLabelText('Add filter tag').fill('BOOK')
    await expect
      .element(page.getByRole('button', { name: 'Pin #book', exact: true }))
      .toBeDisabled()

    await vi.waitFor(() => expect(saved()).toEqual([]))
  })

  it('removes a filter tag and persists the rest', async () => {
    stored = { allNotesFilterTags: ['book', 'person'] }
    await renderScreen()
    // Wait for hydration (the stored list has no `link`), not just defaults.
    await expectLocatorToHaveCount(page.getByText('#link'), 0)
    await expect.element(page.getByText('#book')).toBeInTheDocument()

    await page.getByRole('button', { name: 'Actions for #book' }).click()
    await page.getByRole('menuitem', { name: 'Unpin', exact: true }).click()

    expect(page.getByRole('button', { name: 'Actions for #book' }).query()).toBeNull()
    await vi.waitFor(() => {
      expect(saved()).toEqual([
        {
          ...DEFAULT_SETTINGS,
          allNotesFilterTags: ['person'],
        },
      ])
    })
  })

  it('orders pinned filters through their menus and retains the moved row focus', async () => {
    await renderScreen()
    await expect
      .element(page.getByRole('button', { name: 'Actions for #link' }))
      .toBeInTheDocument()

    await page.getByRole('button', { name: 'Actions for #link' }).click()
    await page.getByRole('menuitem', { name: 'Move up', exact: true }).click()

    await vi.waitFor(() => {
      expect(saved()).toEqual([
        expect.objectContaining({ allNotesFilterTags: ['link', 'book', 'person'] }),
      ])
    })
    await expect.element(page.getByRole('button', { name: 'Actions for #link' })).toHaveFocus()
    expect(page.getByRole('list', { name: 'Pinned filters' }).element().textContent).toMatch(
      /#link.*#book.*#person/,
    )

    await page.getByRole('button', { name: 'Actions for #link' }).click()
    await expect
      .element(page.getByRole('menuitem', { name: 'Move up', exact: true }))
      .toHaveAttribute('aria-disabled', 'true')
    await userEvent.keyboard('{Escape}')
  })

  it('keeps the saved pin order visible while searching for a tag to add', async () => {
    await renderScreen()
    await page.getByLabelText('Add filter tag').fill('research')

    expect(page.getByRole('list', { name: 'Pinned filters' }).element().textContent).toMatch(
      /#book.*#link.*#person/,
    )
    await expect.element(page.getByRole('button', { name: 'Pin #research' })).toBeEnabled()
    expect(saved()).toEqual([])
  })

  it('retains an empty pinned list after removing the final filter and reopening settings', async () => {
    stored = { allNotesFilterTags: ['book'] }
    const screen = await renderScreen()
    await expectLocatorToHaveCount(page.getByRole('button', { name: 'Actions for #person' }), 0)

    await page.getByRole('button', { name: 'Actions for #book' }).click()
    await page.getByRole('menuitem', { name: 'Unpin', exact: true }).click()
    await expect.element(page.getByLabelText('Add filter tag')).toHaveFocus()
    await vi.waitFor(() => expect(saved().at(-1)).toMatchObject({ allNotesFilterTags: [] }))
    await screen.unmount()

    stored = { allNotesFilterTags: [] }
    await renderScreen()
    await expectLocatorToHaveCount(page.getByRole('button', { name: /Actions for #/ }), 0)
    await expect.element(page.getByText('No pinned tags. Add a tag below.')).toBeInTheDocument()
  })

  it('toggles an All Notes attachment filter off and back on, in a fixed order', async () => {
    stored = { allNotesFilterAttachments: ['video', 'pdf'] }
    await renderScreen()
    const audio = page.getByRole('switch', { name: 'Show the Audio filter' })
    const video = page.getByRole('switch', { name: 'Show the Video filter' })
    await expect.element(video).toHaveAttribute('aria-checked', 'true')
    await expect.element(audio).toHaveAttribute('aria-checked', 'false')

    await audio.click()
    await vi.waitFor(() => {
      expect(saved().at(-1)).toMatchObject({
        allNotesFilterAttachments: ['pdf', 'audio', 'video'],
      })
    })
    await video.click()
    await vi.waitFor(() => {
      expect(saved().at(-1)).toMatchObject({ allNotesFilterAttachments: ['pdf', 'audio'] })
    })
  })

  it('enabling semantic search persists the opt-in', async () => {
    await renderScreen()
    const enable = page.getByRole('button', { name: /enable semantic search/i })

    await enable.click()

    await vi.waitFor(() => {
      expect(saved()).toEqual([
        {
          ...DEFAULT_SETTINGS,
          semanticSearchEnabled: true,
        },
      ])
    })
    // The control flips to the loading state (EmbeddingsSync owns the actual
    // download; the runtime here still reports `uninitialized`).
    await expect
      .element(page.getByRole('progressbar', { name: /model download/i }))
      .toBeInTheDocument()
  })

  it('shows byte-level progress while the model downloads', async () => {
    stored = { semanticSearchEnabled: true }
    embedRuntime.setStatus({
      status: 'loading',
      progress: { downloaded: 45_000_000, total: 90_000_000 },
    })
    await renderScreen()

    const bar = page.getByRole('progressbar', { name: /model download/i })
    await expect.element(bar).toHaveAttribute('aria-valuenow', '50')
    await expect
      .element(page.getByText('Downloading the model — 45 MB of 90 MB'))
      .toBeInTheDocument()
  })

  it('shows the downloaded model once ready and persists a disable', async () => {
    stored = { semanticSearchEnabled: true }
    embedRuntime.setStatus({ status: 'ready', model: 'all-MiniLM-L6-v2', dims: 384 })
    await renderScreen()

    await expect.element(page.getByText(/model downloaded \(MiniLM\)/i)).toBeInTheDocument()

    await page.getByRole('button', { name: /disable/i }).click()

    await vi.waitFor(() => {
      expect(saved()).toEqual([
        {
          ...DEFAULT_SETTINGS,
        },
      ])
    })
    await expect
      .element(page.getByRole('button', { name: /enable semantic search/i }))
      .toBeInTheDocument()
    // Disabling is immediate — every semantic consumer gates on the setting,
    // so there is no "takes effect on the next launch" caveat to show even
    // while the runtime still reports `ready`.
    expect(page.getByText(/next launch/i).query()).toBeNull()
  })

  it('offers no semantic search control without an embedding runtime', async () => {
    stored = { semanticSearchEnabled: true }
    embedRuntime.setStatus({ status: 'unsupported' })
    await renderScreen()

    await expect
      .element(page.getByText('Semantic search is not available on this device.'))
      .toBeInTheDocument()
    expect(page.getByRole('button', { name: /enable semantic search/i }).query()).toBeNull()
    expect(page.getByRole('progressbar', { name: /model download/i }).query()).toBeNull()
  })

  it('re-enabling after a failed load retries the download', async () => {
    embedRuntime.setStatus({ status: 'failed', message: 'offline' })
    await renderScreen()
    const enable = page.getByRole('button', { name: /enable semantic search/i })

    await enable.click()

    // The opt-in persists AND the broken runtime gets a fresh embed_ensure —
    // EmbeddingsSync only loads `uninitialized` runtimes, so the explicit
    // action carries the retry.
    await vi.waitFor(() => expect(embedRuntime.ensureCalls()).toBeGreaterThan(0))
    await vi.waitFor(() => {
      expect(saved()).toEqual([
        {
          ...DEFAULT_SETTINGS,
          semanticSearchEnabled: true,
        },
      ])
    })
  })

  it('offers the model choice only once semantic search is on', async () => {
    await renderScreen()
    await expect
      .element(page.getByText(/enabling downloads MiniLM \(91 MB\) once/))
      .toBeInTheDocument()
    await expect.element(page.getByText('Semantic search model')).not.toBeInTheDocument()

    await page.getByRole('button', { name: /enable semantic search/i }).click()

    await expect.element(page.getByText('Semantic search model')).toBeInTheDocument()
  })

  it('choosing a semantic model persists it', async () => {
    stored = { semanticSearchEnabled: true }
    embedRuntime.setStatus({ status: 'ready', model: 'all-MiniLM-L6-v2', dims: 384 })
    await renderScreen()

    await pickRadio(/EmbeddingGemma/)

    await vi.waitFor(() => {
      expect(saved().at(-1)).toMatchObject({ semanticModel: 'embeddinggemma-300m' })
    })
    await expect.element(radio(/EmbeddingGemma/)).toBeChecked()
  })

  it('choosing a model after a failed load retries with that model', async () => {
    stored = { semanticSearchEnabled: true }
    embedRuntime.setStatus({ status: 'failed', message: 'offline' })
    await renderScreen()

    await pickRadio(/EmbeddingGemma/)

    await vi.waitFor(() => expect(embedRuntime.ensuredModels()).toEqual(['embeddinggemma-300m']))
  })

  it('shows the embedding pass that follows a model switch', async () => {
    stored = { semanticSearchEnabled: true }
    embedRuntime.setStatus({ status: 'ready', model: 'embeddinggemma-300m', dims: 768 })
    await renderScreen()
    await act(() => app.semanticSearch.setIndexProgress({ done: 1200, total: 6000 }))

    await expect
      .element(page.getByRole('progressbar', { name: /semantic index/i }))
      .toHaveAttribute('aria-valuenow', '20')
    await expect
      .element(page.getByText('Updating the semantic index: 1,200 of 6,000 notes'))
      .toBeInTheDocument()
  })

  it('surfaces a failed load with retry and disable affordances', async () => {
    stored = { semanticSearchEnabled: true }
    embedRuntime.setStatus({ status: 'failed', message: 'no disk space' })
    await renderScreen()

    await expect.element(page.getByRole('alert')).toBeInTheDocument()
    await expect.element(page.getByText(/no disk space/i)).toBeInTheDocument()
    await expect.element(page.getByRole('button', { name: /try again/i })).toBeInTheDocument()

    // Backing out after a failure must work too — the opt-in isn't a trap.
    await page.getByRole('button', { name: /disable/i }).click()

    await vi.waitFor(() => {
      expect(saved()).toEqual([
        {
          ...DEFAULT_SETTINGS,
        },
      ])
    })
    await expect
      .element(page.getByRole('button', { name: /enable semantic search/i }))
      .toBeInTheDocument()
  })

  it('rebuilding the index wipes and re-applies the projection through the bridge', async () => {
    await renderScreen()

    await page.getByRole('button', { name: /rebuild index/i }).click()

    // The whole chain: button → the index lifecycle's visible rebuild → wipe,
    // then the projection-version stamp that marks a completed rebuild. (The
    // graph is empty here, so there is no apply batch in between.)
    const indexCalls = (): string[] => app.indexStore.calls().map((call) => call.method)
    await vi.waitFor(() => expect(indexCalls()).toContain('clear'))
    await vi.waitFor(() => expect(indexCalls()).toContain('setMeta'))
  })

  it('disables the index rebuild until a graph index is open', async () => {
    openGraph = { ...openGraph, indexGeneration: null }
    await renderScreen()
    const button = page.getByRole('button', { name: /rebuild index/i })
    await expect.element(button).toBeDisabled()
  })

  it('opens the global shortcuts dialog from the editor settings row', async () => {
    await renderScreen()
    const section = page.getByRole('region', { name: 'Editor' })

    await section.getByRole('button', { name: /show all/i }).click()

    const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' })
    // App scope (command titles) and editor scope (binding descriptions) still
    // come from the global cheat-sheet, not from a duplicated settings list.
    await expect.element(dialog.getByText('Toggle sidebar')).toBeInTheDocument()
    await expect.element(dialog.getByText('Go to today')).toBeInTheDocument()
    await expect.element(dialog.getByText('Bold')).toBeInTheDocument()
    await expect.element(dialog.getByText('Heading 1')).toBeInTheDocument()
    await expect.element(dialog.getByText('Open the AI menu on the selection')).toBeInTheDocument()
  })

  it('reflects and persists the AI chat system prompt', async () => {
    stored = { chatSystemPrompt: 'Answer as a careful research partner.' }
    await renderScreen()
    const textarea = page.getByRole('textbox', { name: 'System prompt' })
    await expect.element(textarea).toHaveValue('Answer as a careful research partner.')

    await textarea.fill('  Challenge my assumptions.\nKeep the recommendation short.  ')
    await userEvent.tab()

    await vi.waitFor(() => {
      expect(saved().at(-1)).toMatchObject({
        chatSystemPrompt: 'Challenge my assumptions.\nKeep the recommendation short.',
      })
    })
  })

  it('clears the AI chat prompt', async () => {
    stored = { chatSystemPrompt: 'Always answer in haiku.' }
    await renderScreen()
    const section = page.getByRole('region', { name: 'AI chat' })
    await expect.element(section.getByRole('textbox')).toHaveValue('Always answer in haiku.')

    await section.getByRole('button', { name: 'Clear' }).click()

    await vi.waitFor(() => expect(saved().at(-1)).toMatchObject({ chatSystemPrompt: '' }))
  })

  it('keeps long AI prompts scrollable within the viewport', async () => {
    await renderScreen()
    const section = page.getByRole('region', { name: 'AI prompts' })

    await section.getByRole('button', { name: /add prompt/i }).click()
    const dialog = page.getByRole('dialog', { name: /add prompt/i })
    const promptBody = dialog.getByPlaceholder(/Translate the following/)
    await expect.element(promptBody).toBeInTheDocument()

    expect(dialog.element().className).toContain('max-h-[calc(100dvh-2rem)]')
    expect(dialog.element().className).toContain('overflow-y-auto')
    expect(promptBody.element().className).toContain('field-sizing-fixed')
    expect(promptBody.element().className).toContain('max-h-[50dvh]')
    expect(promptBody.element().className).toContain('resize-y')
    expect(promptBody.element().className).toContain('overflow-y-auto')
  })

  it('adding an AI prompt persists the full document', async () => {
    await renderScreen()
    const section = page.getByRole('region', { name: 'AI prompts' })

    await section.getByRole('button', { name: /add prompt/i }).click()
    const dialog = page.getByRole('dialog', { name: /add prompt/i })
    await dialog.getByPlaceholder('Translate to French').fill('Translate to French')
    await dialog
      .getByPlaceholder(/Translate the following/)
      .fill('Translate to French.\n\n{{selectedText}}')
    await dialog.getByRole('button', { name: /add prompt/i }).click()

    await vi.waitFor(() => {
      expect(saved()).toEqual([
        {
          ...DEFAULT_SETTINGS,
          aiPrompts: [
            {
              id: expect.any(String) as string,
              label: 'Translate to French',
              body: 'Translate to French.\n\n{{selectedText}}',
              mode: 'replace',
            },
          ],
        },
      ])
    })
    await expect
      .element(section.getByText('Translate to French', { exact: true }))
      .toBeInTheDocument()
  })

  it('removing a saved AI prompt persists the emptied list', async () => {
    stored = {
      aiPrompts: [
        { id: 'p1', label: 'Translate to French', body: '{{selectedText}}', mode: 'replace' },
      ],
    }
    await renderScreen()
    const section = page.getByRole('region', { name: 'AI prompts' })
    const remove = section.getByRole('button', {
      name: /remove translate to french/i,
    })

    await remove.click()

    await vi.waitFor(() => {
      expect(saved()).toEqual([
        {
          ...DEFAULT_SETTINGS,
        },
      ])
    })
  })

  it('editing a saved AI prompt persists the change', async () => {
    stored = {
      aiPrompts: [
        { id: 'p1', label: 'Translate to French', body: '{{selectedText}}', mode: 'replace' },
      ],
    }
    await renderScreen()
    const section = page.getByRole('region', { name: 'AI prompts' })
    const edit = section.getByRole('button', { name: /edit translate to french/i })

    await edit.click()
    const dialog = page.getByRole('dialog', { name: /edit prompt/i })
    await dialog.getByPlaceholder('Translate to French').fill('Translate to German')
    await dialog.getByRole('button', { name: /^save$/i }).click()

    await vi.waitFor(() => {
      expect(saved()).toEqual([
        {
          ...DEFAULT_SETTINGS,
          aiPrompts: [
            { id: 'p1', label: 'Translate to German', body: '{{selectedText}}', mode: 'replace' },
          ],
        },
      ])
    })
  })
})
