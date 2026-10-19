import { describe, expect, it } from 'vitest'
import { createTestIpcBridgeService } from '../testing/ipc.ts'
import { createTestLoggerService } from '../testing/logger.ts'
import { createLocalTranscriptionService } from './local-transcription-service.ts'

const INPUT = {
  path: 'audio-memos/audio-memo-2026-06-11-153022-845.webm',
  generation: 3,
  model: 'large-v3-turbo',
  languages: ['en', 'zh'],
  prompt: 'Names: Ocavue',
} as const

/** The real service over IPC answering `local_transcription_transcribe` with `answer`. */
function setup(answer: unknown = { outcome: 'transcribed', text: '', segments: [] }) {
  const logger = createTestLoggerService()
  const ipc = createTestIpcBridgeService({
    commands: {
      local_transcription_transcribe: () => answer,
      local_transcription_status: () => ({ status: 'ready' }),
      local_transcription_download: () => ({ status: 'downloading' }),
      local_transcription_delete: () => ({ status: 'missing' }),
      local_transcription_check_updates: () => ({ revision: null, generations: ['v4'] }),
      local_transcription_skip_update: () => null,
    },
  })
  return { ipc, logger, service: createLocalTranscriptionService({ ipc, logger }) }
}

/** The Rust side pins the same shapes in `local_transcription::tests`. */
describe('LocalTranscriptionService.transcribe', () => {
  it('sends the spoken languages and parses a transcript', async () => {
    const { ipc, service } = setup({
      outcome: 'transcribed',
      text: 'Hello.',
      segments: [{ startMs: 0, endMs: 1200, text: 'Hello.' }],
    })

    await expect(service.transcribe(INPUT)).resolves.toEqual({
      outcome: 'transcribed',
      text: 'Hello.',
      segments: [{ startMs: 0, endMs: 1200, text: 'Hello.' }],
    })
    expect(ipc.calls()).toEqual([
      { command: 'local_transcription_transcribe', args: { request: INPUT } },
    ])
  })

  it('sends an empty hint as null', async () => {
    const { ipc, service } = setup()

    await service.transcribe({ ...INPUT, languages: [], prompt: '' })
    expect(ipc.calls()).toEqual([
      {
        command: 'local_transcription_transcribe',
        args: { request: { ...INPUT, languages: [], prompt: null } },
      },
    ])
  })

  it('parses an undecodable recording', async () => {
    const { service } = setup({ outcome: 'undecodable', reason: 'no audio' })

    await expect(service.transcribe(INPUT)).resolves.toEqual({
      outcome: 'undecodable',
      reason: 'no audio',
    })
  })
})

describe('LocalTranscriptionService models', () => {
  it('asks for the status, download, deletion and updates of one model', async () => {
    const { ipc, service } = setup()

    await expect(service.status('large-v3-turbo')).resolves.toEqual({ status: 'ready' })
    await expect(service.download('large-v3-turbo')).resolves.toEqual({ status: 'downloading' })
    await expect(service.delete('large-v3-turbo')).resolves.toEqual({ status: 'missing' })
    await expect(service.checkUpdates('large-v3-turbo', true)).resolves.toEqual({
      revision: null,
      generations: ['v4'],
    })
    await service.skipUpdate('"etag-1"')

    expect(ipc.calls()).toEqual([
      { command: 'local_transcription_status', args: { model: 'large-v3-turbo' } },
      { command: 'local_transcription_download', args: { model: 'large-v3-turbo' } },
      { command: 'local_transcription_delete', args: { model: 'large-v3-turbo' } },
      {
        command: 'local_transcription_check_updates',
        args: { model: 'large-v3-turbo', force: true },
      },
      { command: 'local_transcription_skip_update', args: { etag: '"etag-1"' } },
    ])
  })

  it('delivers status events to every subscriber until it unsubscribes', () => {
    const { ipc, logger, service } = setup()
    const first: string[] = []
    const second: string[] = []

    const stopFirst = service.onStatus((model, status) => {
      first.push(`${model}:${status.status}`)
    })
    service.onStatus((model, status) => {
      second.push(`${model}:${status.status}`)
    })
    ipc.emit('local-transcription:status', { model: 'large-v3-turbo', status: { status: 'ready' } })
    stopFirst()
    ipc.emit('local-transcription:status', {
      model: 'large-v3-turbo',
      status: { status: 'missing' },
    })
    ipc.emit('local-transcription:status', { model: 'large-v3-turbo', status: 'bogus' })

    expect(first).toEqual(['large-v3-turbo:ready'])
    expect(second).toEqual(['large-v3-turbo:ready', 'large-v3-turbo:missing'])
    expect(logger.getErrors()).toHaveLength(1)
  })
})
