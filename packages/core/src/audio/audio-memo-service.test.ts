import { describe, expect, it, vi } from 'vitest'
import type { GraphRole } from '../graph/graph-session.ts'
import { audioMemoIdentity, audioMemoPartPath } from './audio-memo.ts'
import type { AiProvidersState } from '../ai/provider-config.ts'
import { AUDIO_MEMOS_DIR } from '../graph/paths.ts'
import { createAiCredentialService } from '../ai/ai-credential-service.ts'
import { createAiProviderConfigService } from '../ai/ai-provider-config-service.ts'
import { createTranscriptEnrichmentService } from '../ai/transcript-enrichment-service.ts'
import type { LocalModelStatus } from '../ai/local-transcription.ts'
import { createBackgroundReconcilerFactory } from '../reconcile/background-reconciler.ts'
import { createBacklinkTargetService } from '../capture/backlink-target-service.ts'
import type { RecorderStatus } from '../recordings/recorder-service.ts'
import type { TranscriptionEngine } from '../settings/schema.ts'
import {
  createTestAiKeyValidationService,
  createTestAssetStoreService,
  createTestAudioRecorderService,
  createTestClockService,
  createTestFileChangeService,
  createTestGraphSessionService,
  createTestIdService,
  createTestIpcBridgeService,
  createTestLanguageModelService,
  createTestActivityPort,
  createTestLocalTranscriptionService,
  createTestLoggerService,
  createTestNoteCreationService,
  createTestNoteFileService,
  createTestProgressPort,
  createTestPlatformService,
  createTestSecretStoreService,
  createTestSettingsService,
  createTestTranscriptionService,
} from '../testing/index.ts'
import { createAudioMemoService, type AudioMemoSurface } from './audio-memo-service.ts'
import type { AudioRecorderFinalSegment } from './audio-recorder-service.ts'
import { createTestRecordingStack } from './audio-memo-test-kit.ts'

const PROVIDERS: AiProvidersState = {
  providers: [{ id: 'cfg-openai', provider: 'openai', model: 'gpt-5.1', keyHint: 'wxyz1' }],
  defaultProviderId: 'cfg-openai',
}
/**
 * Configured, but with no model that can transcribe.
 */
const ANTHROPIC_ONLY: AiProvidersState = {
  providers: [{ id: 'claude', provider: 'anthropic', model: 'claude-fable-5', keyHint: 'wxyz1' }],
  defaultProviderId: 'claude',
}

/**
 * 2026-06-11 15:30:22.845 local — the session start the test clock reports.
 */
const RECORDED_AT = new Date(2026, 5, 11, 15, 30, 22, 845)
const MEMO = audioMemoIdentity(RECORDED_AT, 'audio/mp4')
const FINAL_PATH = audioMemoPartPath(MEMO, 1, true)

function finalSegment(blob: Blob, part = 1): AudioRecorderFinalSegment {
  return {
    audio: { kind: 'blob', blob },
    mimeType: 'audio/mp4',
    sessionStartedMs: 0,
    part,
    end: true,
    durationMs: 4000,
  }
}

const RECORDING_BLOB = new Blob(['audio'], { type: 'audio/mp4' })
const SECOND_BLOB = new Blob(['second'], { type: 'audio/mp4' })
const RECORDING = finalSegment(RECORDING_BLOB)

interface SetupOptions {
  providers?: AiProvidersState
  supported?: boolean
  surfaceHidden?: boolean
  role?: GraphRole
  isMacosDesktop?: boolean
  /**
   * Route recordings through the native recorder, as on a Mac that can tap
   * system audio; off, the recorder reads as unsupported (no native shell).
   */
  native?: boolean
  /**
   * Whether a native recording keeps a menu bar item.
   */
  recordingMenuBar?: boolean
  engine?: TranscriptionEngine
  /**
   * What the on-device model's status reads; downloaded by default.
   */
  localModel?: LocalModelStatus
}

const NATIVE_IDLE: RecorderStatus = {
  supported: true,
  defaultRecordingsFolder: '/Users/someone/Library/Recordings',
  recording: null,
}

/**
 * The native recorder's commands on a test IPC: start and stop flip the
 * recording, and `startElsewhere` is a start from the menu bar or the global
 * shortcut, reported on the status event.
 */
function nativeRecorderIpc(now: () => number) {
  let status = NATIVE_IDLE
  const ipc = createTestIpcBridgeService({
    commands: {
      recorder_status: () => status,
      recorder_start: () => {
        status = {
          ...status,
          recording: { sessionId: 'session-1', startedAtMs: now(), warnings: [] },
        }
        return status
      },
      recorder_stop: () => {
        status = { ...status, recording: null }
        return status
      },
      recorder_cancel: () => {
        status = { ...status, recording: null }
        return status
      },
      recorder_configure: () => null,
      recorder_sessions: () => [],
    },
  })
  return {
    ipc,
    startElsewhere(): void {
      status = {
        ...status,
        recording: { sessionId: 'session-2', startedAtMs: now(), warnings: [] },
      }
      ipc.emit('recorder:status', status)
    },
    /**
     * The native recorder commands sent, in order.
     */
    commands: () =>
      ipc
        .calls()
        .map((call) => call.command)
        .filter((command) => command !== 'recorder_status'),
  }
}

async function setup(options?: SetupOptions) {
  const providers = options?.providers ?? PROVIDERS
  const settings = createTestSettingsService({
    aiProviders: providers.providers,
    defaultAiProviderId: providers.defaultProviderId,
    recordingMenuBar: options?.recordingMenuBar ?? false,
    transcriptionEngine: options?.engine ?? 'cloud',
  })
  await settings.whenLoaded()
  const clock = createTestClockService({ now: RECORDED_AT.getTime() })
  const native = nativeRecorderIpc(() => clock.now())
  const noteFile = createTestNoteFileService()
  const assetStore = createTestAssetStoreService({
    sources: { '/staging/recording-1.part-002-end.m4a': 'staged audio' },
  })
  const recorder = createTestAudioRecorderService(
    options?.supported === undefined ? {} : { supported: options.supported },
  )
  recorder.setStopResult(RECORDING)
  const progress = createTestProgressPort()
  const logger = createTestLoggerService()
  const listDirMock = vi.spyOn(noteFile, 'listDir')
  const aiCredentials = createAiCredentialService({ secretStore: createTestSecretStoreService() })
  const activity = createTestActivityPort()
  const graphSession = createTestGraphSessionService({ graph: { generation: 3 } })
  const localTranscription = createTestLocalTranscriptionService({
    status: options?.localModel ?? { status: 'ready' },
  })
  const { recorder: nativeRecorder, recordings } = createTestRecordingStack({
    ipc: native.ipc,
    nativeShell: options?.native === true,
    noteFile,
    settings,
    localTranscription,
    activity,
    progress,
    logger,
    graphSession,
    ...(options?.role === undefined ? {} : { role: options.role }),
  })
  const service = createAudioMemoService({
    assetStore,
    noteFile,
    backlinkTarget: createBacklinkTargetService({
      noteFile,
      noteCreation: createTestNoteCreationService({ noteFile }),
    }),
    transcription: createTestTranscriptionService(),
    localTranscription,
    transcriptEnrichment: createTranscriptEnrichmentService({
      languageModel: createTestLanguageModelService(),
    }),
    aiProviderConfig: createAiProviderConfigService({
      settings,
      credentials: aiCredentials,
      keyValidation: createTestAiKeyValidationService(),
      id: createTestIdService(),
    }),
    aiCredentials,
    audioRecorder: recorder,
    recorder: nativeRecorder,
    recordings,
    reconcilers: createBackgroundReconcilerFactory({ activity }),
    activity,
    fileChanges: createTestFileChangeService(),
    settings,
    progress,
    clock,
    platform: createTestPlatformService({ isMacosDesktop: options?.isMacosDesktop ?? true }),
    role: options?.role ?? 'main',
    graphSession,
    logger,
  })
  return {
    graphSession,
    settings,
    noteFile,
    assetStore,
    recorder,
    native,
    localTranscription,
    clock,
    progress,
    logger,
    service,
    /**
     * How many transcription passes got past the config gate.
     */
    passes: () => listDirMock.mock.calls.filter(([dir]) => dir === AUDIO_MEMOS_DIR).length,
  }
}

async function openSession(options?: SetupOptions) {
  const kit = await setup(options)
  const surface = {
    reveal: vi.fn<AudioMemoSurface['reveal']>(),
    showReminder: vi.fn<AudioMemoSurface['showReminder']>(),
    dismissReminder: vi.fn<AudioMemoSurface['dismissReminder']>(),
  }
  const session = kit.service.openSession({
    surface,
    surfaceHidden: options?.surfaceHidden ?? false,
  })
  await flush()
  return { ...kit, surface, session, phase: () => session.getState().phase }
}

/**
 * Settle the promise chains a capture or a pass runs on.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function blobText(bytes: Uint8Array | undefined): string {
  return new TextDecoder().decode(bytes)
}

describe('AudioMemoPipeline.listSegments', () => {
  it('lists every segment of one session and nothing else', async () => {
    const { service, noteFile } = await setup()
    const pipeline = service.openPipeline({ isErrorSurfaceVisible: () => true })
    const other = audioMemoIdentity(new Date(2026, 5, 10, 9, 0, 0, 0), 'audio/mp4')
    noteFile.set(audioMemoPartPath(MEMO, 1, false), 'x')
    noteFile.set(audioMemoPartPath(MEMO, 2, true), 'x')
    noteFile.set(audioMemoPartPath(other, 1, true), 'x')
    noteFile.set('audio-memos/voice-note.mp3', 'x')

    expect(await pipeline.listSegments(MEMO)).toEqual([
      audioMemoPartPath(MEMO, 1, false),
      audioMemoPartPath(MEMO, 2, true),
    ])
  })
})

describe('AudioMemoService.openPipeline', () => {
  it('throws when no graph is open', async () => {
    const { service, graphSession } = await setup()
    graphSession.setGraph(null)

    expect(() => service.openPipeline({ isErrorSurfaceVisible: () => true })).toThrow(
      'No graph is open.',
    )
  })

  it('keeps writing to the graph it opened for after a graph switch', async () => {
    const { service, graphSession, assetStore } = await setup()
    const pipeline = service.openPipeline({ isErrorSurfaceVisible: () => true })
    graphSession.setGraph({ generation: 4 })

    pipeline.enqueue({
      audio: RECORDING.audio,
      mimeType: 'audio/mp4',
      recordedAt: RECORDED_AT,
      segment: { part: 1, end: true },
    })
    await flush()

    expect(assetStore.uploads()).toEqual([{ kind: 'path', path: FINAL_PATH, generation: 3 }])
    pipeline.dispose()
  })

  it('a note window gets the capture queue but no transcription lifecycle', async () => {
    const { service, assetStore, passes } = await setup({ role: 'note-window' })
    const pipeline = service.openPipeline({ isErrorSurfaceVisible: () => true })
    await flush()

    pipeline.enqueue({
      audio: RECORDING.audio,
      mimeType: 'audio/mp4',
      recordedAt: RECORDED_AT,
      segment: { part: 1, end: true },
    })
    await flush()

    expect(assetStore.uploads()).toEqual([{ kind: 'path', path: FINAL_PATH, generation: 3 }])
    expect(passes()).toBe(0)
    expect(pipeline.getState().transcribing).toBe(false)
  })

  it('a failing post-capture cleanup is logged, never parked', async () => {
    const { service, logger } = await setup()
    const pipeline = service.openPipeline({ isErrorSurfaceVisible: () => true })
    const cause = new Error('staged file is gone')

    pipeline.enqueue({
      audio: RECORDING.audio,
      mimeType: 'audio/mp4',
      recordedAt: RECORDED_AT,
      segment: { part: 1, end: true },
      onCaptured: () => {
        throw cause
      },
    })
    await flush()

    expect(pipeline.getState()).toMatchObject({ pendingCount: 0, error: null, canRetry: false })
    expect(logger.getErrors()).toEqual([
      { message: 'audio memo post-capture cleanup failed:', cause },
    ])
  })

  it('discarding a parked capture runs its discard cleanup', async () => {
    const { service, assetStore } = await setup()
    vi.spyOn(assetStore, 'uploadToPath').mockRejectedValue({ kind: 'io', message: 'disk full' })
    const pipeline = service.openPipeline({ isErrorSurfaceVisible: () => true })
    const onDiscarded = vi.fn()

    pipeline.enqueue({
      audio: RECORDING.audio,
      mimeType: 'audio/mp4',
      recordedAt: RECORDED_AT,
      segment: { part: 1, end: true },
      onDiscarded,
    })
    await flush()
    expect(pipeline.getState()).toMatchObject({ error: 'disk full', canRetry: true })

    pipeline.discard()
    await flush()

    expect(onDiscarded).toHaveBeenCalledTimes(1)
    expect(pipeline.getState()).toMatchObject({ error: null, canRetry: false })
  })
})

describe('AudioMemoService.openSession', () => {
  it('toggle records, then stops and captures the recording', async () => {
    const { session, phase, assetStore } = await openSession()
    expect(session.getState().available).toBe(true)

    session.toggle()
    await flush()
    expect(phase()).toBe('recording')

    session.toggle()
    await flush()
    expect(phase()).toBe('idle')

    expect(assetStore.uploads()).toEqual([{ kind: 'path', path: FINAL_PATH, generation: 3 }])
    expect(blobText(assetStore.assets().get(FINAL_PATH))).toBe('audio')
  })

  it('keeps one state object until something changes, and notifies subscribers', async () => {
    const { session } = await openSession()
    const listener = vi.fn()
    session.subscribe(listener)
    const before = session.getState()
    expect(session.getState()).toBe(before)

    session.toggle()
    await flush()

    expect(listener).toHaveBeenCalled()
    expect(session.getState()).not.toBe(before)
    expect(session.getState().recorderState).toBe('recording')
  })

  it('runs the launch pass when it opens, and stops following triggers when disposed', async () => {
    const { session, passes } = await openSession()
    expect(passes()).toBe(1)

    session.dispose()
    session.toggle()
    await flush()
    session.toggle()
    await flush()
    expect(passes()).toBe(1)
  })

  it('a saved capture schedules transcription without waiting on the watcher', async () => {
    const { session, passes } = await openSession()
    expect(passes()).toBe(1)

    session.toggle()
    await flush()
    session.toggle()
    await flush()

    expect(passes()).toBe(2)
  })

  it('adding the first transcription-capable model kicks the pass the gate was suppressing', async () => {
    const { session, settings, passes } = await openSession({ providers: ANTHROPIC_ONLY })
    expect(passes()).toBe(0)
    expect(session.getState().available).toBe(false)

    settings.update({
      aiProviders: PROVIDERS.providers,
      defaultAiProviderId: PROVIDERS.defaultProviderId,
    })
    await flush()

    expect(passes()).toBe(1)
    expect(session.getState().available).toBe(true)
  })

  it('a too-short recording is discarded without saving', async () => {
    const { session, phase, recorder, assetStore } = await openSession()
    recorder.setStopResult(null)

    session.toggle()
    await flush()
    session.toggle()
    await flush()

    expect(phase()).toBe('idle')
    expect(assetStore.uploads()).toEqual([])
  })

  it('a capture failure parks an error whose retry re-runs the same recording', async () => {
    const { session, phase, assetStore } = await openSession()
    const uploadMock = vi
      .spyOn(assetStore, 'uploadToPath')
      .mockRejectedValueOnce({ kind: 'io', message: 'disk full' })

    session.toggle()
    await flush()
    session.toggle()
    await flush()
    expect(phase()).toBe('error')
    expect(session.getState().error).toBe('disk full')
    expect(session.getState().canRetry).toBe(true)

    session.retry()
    await flush()
    expect(phase()).toBe('idle')
    expect(uploadMock).toHaveBeenCalledTimes(2)
    expect(uploadMock.mock.calls[1]?.[1]).toBe(RECORDING_BLOB)
  })

  it('rotates the recorder every segment, reminds every half hour, and never stops on its own', async () => {
    const { session, phase, recorder } = await openSession()

    session.toggle()
    await flush()

    expect(recorder.calls()).toContainEqual({
      method: 'start',
      options: { segmentMs: 20 * 60_000, reminderMs: 30 * 60_000 },
    })
    expect(phase()).toBe('recording')
  })

  it('captures a rotated segment while the session keeps recording', async () => {
    const { session, phase, recorder, assetStore } = await openSession()
    session.toggle()
    await flush()

    recorder.emitSegment({
      audio: { kind: 'blob', blob: new Blob(['first'], { type: 'audio/mp4' }) },
      mimeType: 'audio/mp4',
      sessionStartedMs: 0,
      part: 1,
      end: false,
    })
    await flush()

    expect(phase()).toBe('recording')
    expect(assetStore.uploads().map((upload) => upload.path)).toEqual([
      audioMemoPartPath(MEMO, 1, false),
    ])

    recorder.setStopResult(finalSegment(SECOND_BLOB, 2))
    session.toggle()
    await flush()

    expect(assetStore.uploads().map((upload) => upload.path)).toEqual([
      audioMemoPartPath(MEMO, 1, false),
      audioMemoPartPath(MEMO, 2, true),
    ])
  })

  it('follows the elapsed time while recording and resets it afterwards', async () => {
    const { session, recorder } = await openSession()
    session.toggle()
    await flush()

    recorder.emitLevel({ level: 0.5, elapsedMs: 1200 })
    expect(session.getState().elapsedMs).toBe(1200)

    session.cancel()
    await flush()
    expect(session.getState().elapsedMs).toBe(0)
  })

  it('shows the still-recording reminder, and stopping takes it down', async () => {
    const { session, phase, recorder, surface, assetStore } = await openSession()

    session.toggle()
    await flush()
    recorder.emitReminder(30 * 60_000)
    expect(surface.showReminder).toHaveBeenCalledWith(30 * 60_000, expect.any(Function))

    // The reminder carries the stop control with it.
    surface.showReminder.mock.calls[0]?.[1]()
    await flush()

    // Left up, it would keep claiming a session is running, and its stop
    // control would land on whatever recording started next.
    expect(surface.dismissReminder).toHaveBeenCalled()
    expect(phase()).toBe('idle')
    expect(assetStore.uploads()).toHaveLength(1)
  })

  it('hiding the recording UI mid-recording stops and saves', async () => {
    const { session, phase, assetStore } = await openSession()

    session.toggle()
    await flush()
    expect(phase()).toBe('recording')

    session.setSurfaceHidden(true)
    await flush()

    expect(assetStore.uploads()).toHaveLength(1)
  })

  it('the stop click commits immediately — no recording-phase gap for Esc to cancel in', async () => {
    const { session, phase, recorder, assetStore } = await openSession()
    session.toggle()
    await flush()

    const releaseStop = recorder.holdNextStop()
    session.toggle()
    // The recorder's stop hasn't settled, but the phase already left
    // 'recording' — cancel is unreachable from the popover.
    expect(phase()).toBe('transcribing')

    releaseStop()
    await flush()
    expect(phase()).toBe('idle')
    expect(assetStore.uploads()).toHaveLength(1)
  })

  it('a mic click landing in the stop gap starts the next memo once the recorder frees', async () => {
    const { session, phase, recorder, assetStore } = await openSession()
    session.toggle()
    await flush()

    const releaseStop = recorder.holdNextStop()
    session.toggle()
    expect(phase()).toBe('transcribing')

    // The button already reads as the idle mic — the click must not be
    // swallowed by the stop's re-entry guard.
    session.toggle()
    await flush()
    const starts = (): number => recorder.calls().filter((call) => call.method === 'start').length
    expect(starts()).toBe(1)

    releaseStop()
    await flush()
    expect(phase()).toBe('recording')
    expect(starts()).toBe(2)
    expect(assetStore.uploads()).toHaveLength(1)
  })

  it('a new recording can start while a capture is pending, and captures run serially in order', async () => {
    const { session, phase, recorder, assetStore } = await openSession()
    const pendingFirst = Promise.withResolvers<void>()
    const uploadMock = vi
      .spyOn(assetStore, 'uploadToPath')
      .mockImplementationOnce(() => pendingFirst.promise)

    session.toggle()
    await flush()
    session.toggle()
    await flush()
    expect(phase()).toBe('transcribing')

    // The first capture is still in flight — the mic must accept the next memo.
    session.toggle()
    await flush()
    expect(phase()).toBe('recording')

    recorder.setStopResult(finalSegment(SECOND_BLOB))
    session.toggle()
    await flush()
    expect(phase()).toBe('transcribing')
    expect(session.getState().pendingCount).toBe(2)
    // Serial: the second memo waits — captures must land in recording order.
    expect(uploadMock).toHaveBeenCalledTimes(1)

    pendingFirst.resolve()
    await flush()
    expect(phase()).toBe('idle')
    expect(session.getState().pendingCount).toBe(0)
    expect(uploadMock).toHaveBeenCalledTimes(2)
    expect(uploadMock.mock.calls[1]?.[1]).toBe(SECOND_BLOB)
  })

  it('a failure parks the queue; retry lands the failed memo before the ones behind it', async () => {
    const { session, phase, recorder, assetStore } = await openSession()
    const pendingFirst = Promise.withResolvers<void>()
    const uploadMock = vi
      .spyOn(assetStore, 'uploadToPath')
      .mockImplementationOnce(() => pendingFirst.promise)

    session.toggle()
    await flush()
    session.toggle()
    await flush()
    session.toggle()
    await flush()
    recorder.setStopResult(finalSegment(SECOND_BLOB))
    session.toggle()
    await flush()

    pendingFirst.reject({ kind: 'io', message: 'disk full' })
    await flush()
    expect(phase()).toBe('error')
    // The second memo holds behind the failure — retrying later must not
    // write the first recording after the second.
    expect(uploadMock).toHaveBeenCalledTimes(1)

    session.retry()
    await flush()
    expect(phase()).toBe('idle')
    expect(uploadMock.mock.calls.map(([, blob]) => blob)).toEqual([
      RECORDING_BLOB,
      RECORDING_BLOB,
      SECOND_BLOB,
    ])
  })

  it('discarding a failed memo releases the queue behind it', async () => {
    const { session, phase, recorder, assetStore } = await openSession()
    const pendingFirst = Promise.withResolvers<void>()
    const uploadMock = vi
      .spyOn(assetStore, 'uploadToPath')
      .mockImplementationOnce(() => pendingFirst.promise)

    session.toggle()
    await flush()
    session.toggle()
    await flush()
    session.toggle()
    await flush()
    recorder.setStopResult(finalSegment(SECOND_BLOB))
    session.toggle()
    await flush()

    pendingFirst.reject({ kind: 'io', message: 'disk full' })
    await flush()
    expect(phase()).toBe('error')

    session.discard()
    await flush()
    expect(phase()).toBe('idle')
    expect(uploadMock).toHaveBeenCalledTimes(2)
    expect(uploadMock.mock.calls[1]?.[1]).toBe(SECOND_BLOB)
  })

  it('a second toggle during the permission prompt aborts the request', async () => {
    const { session, phase, recorder } = await openSession()
    recorder.holdNextStart()

    session.toggle()
    await flush()
    expect(phase()).toBe('requesting')

    session.toggle()
    await flush()
    expect(recorder.calls()).toContainEqual({ method: 'cancel' })
    expect(phase()).toBe('idle')
  })

  it('a denied microphone maps to the macOS guidance, with no retry', async () => {
    const { session, phase, recorder } = await openSession({ isMacosDesktop: true })
    recorder.failNextStart(new DOMException('denied', 'NotAllowedError'))

    session.toggle()
    await flush()

    expect(phase()).toBe('error')
    expect(session.getState().canRetry).toBe(false)
    expect(session.getState().error).toBe(
      'Microphone access was denied. Allow it in System Settings → Privacy & Security → Microphone.',
    )
  })

  it('a denied microphone maps to the generic guidance off macOS', async () => {
    const { session, recorder } = await openSession({ isMacosDesktop: false })
    recorder.failNextStart(new DOMException('denied', 'NotAllowedError'))

    session.toggle()
    await flush()

    expect(session.getState().error).toBe(
      'Microphone access was denied. Allow microphone access for Reflect in your system settings.',
    )
  })

  it('any other start failure shows its own message', async () => {
    const { session, recorder } = await openSession()
    recorder.failNextStart(new Error('no input device'))

    session.toggle()
    await flush()

    expect(session.getState().error).toBe('no input device')
  })

  it('hiding the recording UI during the permission prompt abandons the request', async () => {
    const { session, phase, recorder, assetStore } = await openSession()
    recorder.holdNextStart()

    session.toggle()
    await flush()
    expect(phase()).toBe('requesting')

    session.setSurfaceHidden(true)
    await flush()

    expect(recorder.calls()).toContainEqual({ method: 'cancel' })
    expect(assetStore.uploads()).toEqual([])
  })

  it('a capture failure while the recording UI is hidden surfaces through operations', async () => {
    const { session, assetStore, progress } = await openSession()
    vi.spyOn(assetStore, 'uploadToPath').mockRejectedValue({ kind: 'io', message: 'disk full' })

    session.toggle()
    await flush()
    session.setSurfaceHidden(true)
    await flush()

    expect(progress.findByLabel('Saving audio memo')).toMatchObject({
      status: 'failed',
      message: 'disk full',
    })
  })

  it('a capture failure while the recording UI is visible stays off the operations list', async () => {
    const { session, phase, assetStore, progress } = await openSession()
    vi.spyOn(assetStore, 'uploadToPath').mockRejectedValue({ kind: 'io', message: 'disk full' })

    session.toggle()
    await flush()
    session.toggle()
    await flush()

    expect(phase()).toBe('error')
    expect(progress.getAll()).toEqual([])
  })

  it('a parked error never invisibly blocks recording: toggle surfaces, then clears it', async () => {
    const { session, phase, assetStore, surface } = await openSession()
    vi.spyOn(assetStore, 'uploadToPath').mockRejectedValue({ kind: 'io', message: 'disk full' })

    // Fail a capture, then hide — the error popover unmounts with the mic.
    session.toggle()
    await flush()
    session.toggle()
    await flush()
    expect(phase()).toBe('error')
    session.setSurfaceHidden(true)

    // Hidden: toggle re-surfaces the error instead of doing nothing.
    session.toggle()
    await flush()
    expect(surface.reveal).toHaveBeenCalledTimes(1)
    expect(phase()).toBe('error')

    // Visible: toggle acknowledges the error; the next one records.
    session.setSurfaceHidden(false)
    session.toggle()
    await flush()
    expect(phase()).toBe('idle')
    session.toggle()
    await flush()
    expect(phase()).toBe('recording')
  })

  it('starting with the recording UI hidden reveals it first', async () => {
    const { session, recorder, surface } = await openSession({ surfaceHidden: true })

    session.toggle()
    await flush()

    expect(surface.reveal).toHaveBeenCalledTimes(1)
    expect(recorder.calls().some((call) => call.method === 'start')).toBe(true)
  })

  it('is unavailable without an OpenAI or Gemini model, and nothing runs', async () => {
    const { session, phase, recorder, passes } = await openSession({ providers: ANTHROPIC_ONLY })

    expect(session.getState().available).toBe(false)
    expect(session.getState().unavailableReason).toMatch(/OpenAI or Gemini/)

    session.toggle()
    await flush()
    expect(phase()).toBe('idle')
    expect(recorder.calls().some((call) => call.method === 'start')).toBe(false)
    // The lifecycle still mounts (its passes gate internally), but nothing
    // gets past the gate.
    expect(passes()).toBe(0)
  })

  it('is unavailable where the platform cannot record', async () => {
    const { session, recorder } = await openSession({ supported: false })

    expect(session.getState().available).toBe(false)
    expect(session.getState().unavailableReason).toBe(
      'Audio recording is not supported on this platform',
    )

    session.toggle()
    await flush()
    expect(recorder.calls().some((call) => call.method === 'start')).toBe(false)
  })

  it('on the on-device engine, is available once its model is downloaded — no cloud model needed', async () => {
    const { session, localTranscription } = await openSession({
      engine: 'local',
      providers: ANTHROPIC_ONLY,
      localModel: { status: 'missing' },
    })

    expect(session.getState().available).toBe(false)
    expect(session.getState().unavailableReason).toBe(
      'Download the on-device transcription model in Settings to record audio memos',
    )

    localTranscription.setStatus('large-v3-turbo', { status: 'ready' })
    await flush()

    expect(session.getState()).toMatchObject({ available: true, unavailableReason: null })
  })

  it('switching to the on-device engine asks for its model before calling it available', async () => {
    const { session, settings, localTranscription } = await openSession({
      providers: ANTHROPIC_ONLY,
    })
    const status = vi.spyOn(localTranscription, 'status')
    expect(session.getState().unavailableReason).toMatch(/OpenAI or Gemini/)

    settings.update({ transcriptionEngine: 'local' })
    await flush()

    expect(status).toHaveBeenCalledWith('large-v3-turbo')
    expect(session.getState()).toMatchObject({ available: true, unavailableReason: null })
  })

  it('cancel discards the recording without saving', async () => {
    const { session, phase, recorder, assetStore, surface } = await openSession()

    session.toggle()
    await flush()
    session.cancel()
    await flush()

    expect(phase()).toBe('idle')
    expect(recorder.calls()).toContainEqual({ method: 'cancel' })
    expect(surface.dismissReminder).toHaveBeenCalled()
    expect(assetStore.uploads()).toEqual([])
  })

  it('cancel deletes the segments the session already wrote', async () => {
    const { session, recorder, assetStore } = await openSession()
    session.toggle()
    await flush()
    recorder.emitSegment({
      audio: { kind: 'blob', blob: new Blob(['first'], { type: 'audio/mp4' }) },
      mimeType: 'audio/mp4',
      sessionStartedMs: 0,
      part: 1,
      end: false,
    })
    await flush()
    expect([...assetStore.assets().keys()]).toEqual([audioMemoPartPath(MEMO, 1, false)])

    session.cancel()
    await flush()

    expect(assetStore.assets().size).toBe(0)
  })

  it('a cancel landing while a segment is being written deletes it once it lands', async () => {
    const { session, recorder, assetStore } = await openSession()
    const upload = assetStore.uploadToPath.bind(assetStore)
    const held = Promise.withResolvers<void>()
    vi.spyOn(assetStore, 'uploadToPath').mockImplementationOnce(async (...args) => {
      await held.promise
      await upload(...args)
    })
    session.toggle()
    await flush()
    recorder.emitSegment({
      audio: { kind: 'blob', blob: new Blob(['first'], { type: 'audio/mp4' }) },
      mimeType: 'audio/mp4',
      sessionStartedMs: 0,
      part: 1,
      end: false,
    })
    await flush()

    session.cancel()
    held.resolve()
    await flush()

    expect(assetStore.uploads()).toHaveLength(1)
    expect(assetStore.assets().size).toBe(0)
  })

  it('dispose releases the microphone', async () => {
    const { session, recorder } = await openSession()
    session.toggle()
    await flush()

    session.dispose()

    expect(recorder.calls()).toContainEqual({ method: 'cancel' })
    expect(recorder.state()).toBe('idle')
  })
})

describe('AudioMemoService.openSession with the native recorder', () => {
  it('records through the native recorder, ticking the elapsed time, never the webview mic', async () => {
    const { session, phase, native, recorder, clock } = await openSession({ native: true })
    expect(session.getState()).toMatchObject({ nativeRecorder: true, available: true })

    session.toggle()
    await flush()
    expect(phase()).toBe('recording')
    await clock.advance(1000)
    expect(session.getState().elapsedMs).toBe(1000)

    session.toggle()
    await flush()
    expect(phase()).toBe('idle')
    expect(native.commands()).toEqual(['recorder_start', 'recorder_stop'])
    expect(recorder.calls().some((call) => call.method === 'start')).toBe(false)
  })

  it('records even without a transcription model: the recording pass says when it stops', async () => {
    const { session } = await openSession({ native: true, providers: ANTHROPIC_ONLY })

    expect(session.getState()).toMatchObject({ available: true, unavailableReason: null })
  })

  it('cancel discards the native recording', async () => {
    const { session, native } = await openSession({ native: true })
    session.toggle()
    await flush()

    session.cancel()
    await flush()

    expect(native.commands()).toEqual(['recorder_start', 'recorder_cancel'])
    expect(session.getState().phase).toBe('idle')
  })

  it('collapsing the sidebar ends a native recording that has no menu bar item, once', async () => {
    const { session, native } = await openSession({ native: true })
    session.toggle()
    await flush()

    session.setSurfaceHidden(true)
    await flush()
    expect(native.commands()).toEqual(['recorder_start', 'recorder_stop'])

    // Later reports while still collapsed (a status tick) never toggle again.
    session.setSurfaceHidden(true)
    await flush()
    expect(native.commands()).toEqual(['recorder_start', 'recorder_stop'])
  })

  it('a native recording started while collapsed is shown, never stopped', async () => {
    const { session, native, surface } = await openSession({ native: true, surfaceHidden: true })

    // The global shortcut starts a recording from another app.
    native.startElsewhere()
    await flush()
    session.setSurfaceHidden(true)
    await flush()

    expect(native.commands()).toEqual([])
    expect(surface.reveal).toHaveBeenCalledTimes(1)
    expect(session.getState().phase).toBe('recording')
  })

  it('a native recording with a menu bar item survives the collapse', async () => {
    const { session, native, surface } = await openSession({
      native: true,
      recordingMenuBar: true,
    })
    session.toggle()
    await flush()

    session.setSurfaceHidden(true)
    await flush()

    expect(native.commands()).toEqual(['recorder_start'])
    expect(surface.reveal).not.toHaveBeenCalled()
    expect(session.getState().phase).toBe('recording')
  })

  it('starting with the recording UI hidden reveals it first', async () => {
    const { session, native, surface } = await openSession({ native: true, surfaceHidden: true })

    session.toggle()
    await flush()

    expect(surface.reveal).toHaveBeenCalledTimes(1)
    expect(native.commands()).toEqual(['recorder_start'])
  })

  it('dispose stops ticking the native elapsed time', async () => {
    const { session, clock } = await openSession({ native: true })
    session.toggle()
    await flush()
    expect(clock.pendingTimers()).toBeGreaterThan(0)

    session.dispose()

    expect(clock.pendingTimers()).toBe(0)
  })
})
