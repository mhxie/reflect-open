import { describe, expect, it } from 'vitest'
import { AppError } from '../errors.ts'
import {
  createTestIpcBridgeService,
  createTestLoggerService,
  createTestPlatformService,
  createTestProgressPort,
} from '../testing/index.ts'
import {
  createRecorderService,
  IDLE_RECORDER_STATUS,
  type RecorderStatus,
} from './recorder-service.ts'

const IDLE: RecorderStatus = {
  supported: true,
  defaultRecordingsFolder: '/Users/someone/Library/Recordings',
  recording: null,
}

const RECORDING: RecorderStatus = {
  ...IDLE,
  recording: { sessionId: 'session-1', startedAtMs: 1_000, warnings: [] },
}

/**
 * The recorder over the native commands on a test IPC: `recorder_status`
 * answers `status`, start and stop flip it, and `failing` makes a control fail.
 */
function setup(options: { nativeShell?: boolean } = {}) {
  let status = IDLE
  let failing: string | null = null
  const control = (next: RecorderStatus) => (): RecorderStatus => {
    if (failing !== null) {
      throw new AppError('io', failing)
    }
    status = next
    return status
  }
  const ipc = createTestIpcBridgeService({
    commands: {
      recorder_status: () => status,
      recorder_start: control(RECORDING),
      recorder_stop: control(IDLE),
      recorder_cancel: control(IDLE),
      recorder_configure: () => null,
      recorder_sessions: () => [
        { id: 'session-0', startedAtMs: 0, endedAtMs: 500, transcribed: true, warnings: [] },
      ],
      recorder_transcribe: () => ({
        model: 'large-v3-turbo',
        durationMs: 500,
        me: [{ startMs: 0, endMs: 400, text: 'hello' }],
        them: [],
        echoSuppressed: false,
        systemSilent: true,
      }),
      recorder_archive: () => null,
    },
  })
  const progress = createTestProgressPort()
  const logger = createTestLoggerService()
  const recorder = createRecorderService({
    ipc,
    platform: createTestPlatformService({ isNativeShell: options.nativeShell ?? true }),
    progress,
    logger,
  })
  return {
    recorder,
    ipc,
    progress,
    logger,
    failNext: (message: string): void => {
      failing = message
    },
    commands: () => ipc.calls().map((call) => call.command),
  }
}

/**
 * Settle the promise chains a subscription and a control run on.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('RecorderService', () => {
  it('reads the status once followed, tracks its events, and stops following with the last subscriber', async () => {
    const { recorder, ipc } = setup()
    expect(recorder.getState()).toBe(IDLE_RECORDER_STATUS)
    let notified = 0
    const unsubscribe = recorder.subscribe(() => {
      notified += 1
    })
    await flush()
    expect(recorder.getState()).toEqual(IDLE)

    ipc.emit('recorder:status', RECORDING)
    expect(recorder.getState()).toEqual(RECORDING)
    expect(notified).toBe(2)

    unsubscribe()
    ipc.emit('recorder:status', IDLE)
    expect(recorder.getState()).toEqual(RECORDING)
  })

  it('never asks the native side outside the native shell', async () => {
    const { recorder, commands } = setup({ nativeShell: false })
    recorder.subscribe(() => {})
    const level = recorder.subscribeLevel(() => {})
    await flush()

    expect(recorder.getState()).toBe(IDLE_RECORDER_STATUS)
    expect(commands()).toEqual([])
    level()
  })

  it('starts, then stops, adopting the status each control answers', async () => {
    const { recorder, commands } = setup()
    recorder.subscribe(() => {})
    await flush()

    await recorder.toggleRecording()
    expect(recorder.getState()).toEqual(RECORDING)
    await recorder.toggleRecording()
    expect(recorder.getState()).toEqual(IDLE)
    await recorder.toggleRecording()
    await recorder.cancelRecording()

    expect(commands().filter((command) => command !== 'recorder_status')).toEqual([
      'recorder_start',
      'recorder_stop',
      'recorder_start',
      'recorder_cancel',
    ])
  })

  it('reports a failed control as a failed Recording operation, never rejecting', async () => {
    const { recorder, progress, failNext } = setup()
    failNext('the microphone is in use')

    await expect(recorder.toggleRecording()).resolves.toBeUndefined()

    expect(progress.findByLabel('Recording')).toMatchObject({
      status: 'failed',
      message: 'the microphone is in use',
    })
  })

  it('sends an empty shortcut, folder and hint as null', async () => {
    const { recorder, ipc } = setup()

    await recorder.configure({ menuBar: true, shortcut: '', recordingsFolder: '' })
    await recorder.configure({
      menuBar: false,
      shortcut: 'Control+Option+Command+M',
      recordingsFolder: '/Volumes/Archive',
    })
    const channels = await recorder.transcribe({
      sessionId: 'session-0',
      model: 'large-v3-turbo',
      languages: ['en'],
      prompt: '',
    })
    await recorder.archive('session-0', '/Volumes/Archive/recording.m4a')

    expect(channels.me).toEqual([{ startMs: 0, endMs: 400, text: 'hello' }])
    expect(ipc.calls()).toEqual([
      {
        command: 'recorder_configure',
        args: { config: { menuBar: true, shortcut: null, recordingsFolder: null } },
      },
      {
        command: 'recorder_configure',
        args: {
          config: {
            menuBar: false,
            shortcut: 'Control+Option+Command+M',
            recordingsFolder: '/Volumes/Archive',
          },
        },
      },
      {
        command: 'recorder_transcribe',
        args: {
          request: {
            sessionId: 'session-0',
            model: 'large-v3-turbo',
            languages: ['en'],
            prompt: null,
          },
        },
      },
      {
        command: 'recorder_archive',
        args: {
          request: { sessionId: 'session-0', destination: '/Volumes/Archive/recording.m4a' },
        },
      },
    ])
  })

  it('lists the staged recordings', async () => {
    const { recorder } = setup()

    expect(await recorder.finishedRecordings()).toEqual([
      { id: 'session-0', startedAtMs: 0, endedAtMs: 500, transcribed: true, warnings: [] },
    ])
  })

  it('delivers warnings and stopped recordings, logging a malformed payload', async () => {
    const { recorder, ipc, logger } = setup()
    const warnings: string[] = []
    const finished: string[] = []
    recorder.onWarning((code, sessionId) => {
      warnings.push(`${sessionId}:${code}`)
    })
    recorder.onFinished((sessionId) => {
      finished.push(sessionId)
    })
    await flush()

    ipc.emit('recorder:warning', { sessionId: 'session-1', code: 'noAudio' })
    ipc.emit('recorder:warning', { code: 7 })
    ipc.emit('recorder:recorded', { sessionId: 'session-1' })

    expect(warnings).toEqual(['session-1:noAudio'])
    expect(finished).toEqual(['session-1'])
    expect(logger.getErrors().map((entry) => entry.message)).toEqual([
      'invalid recorder:warning payload:',
    ])
  })

  it('shares one native level subscription across its listeners', async () => {
    const { recorder, ipc } = setup()
    const first: number[] = []
    const second: number[] = []
    const stopFirst = recorder.subscribeLevel((level) => {
      first.push(level)
    })
    const stopSecond = recorder.subscribeLevel((level) => {
      second.push(level)
    })
    await flush()

    ipc.emit('recorder:level', 0.5)
    stopFirst()
    ipc.emit('recorder:level', 0.25)
    ipc.emit('recorder:level', 'loud')

    expect(first).toEqual([0.5])
    expect(second).toEqual([0.5, 0.25])
    stopSecond()
  })
})
