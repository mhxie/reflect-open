import { afterEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '../ipc/bridge.ts'
import { transcribeLocally } from './local-transcription.ts'

afterEach(() => {
  setBridge(null)
})

const INPUT = {
  path: 'audio-memos/audio-memo-2026-06-11-153022-845.webm',
  generation: 3,
  model: 'large-v3-turbo',
  languages: ['en', 'zh'],
  prompt: 'Names: Ocavue',
} as const

/** The Rust side pins the same shapes in `local_transcription::tests`. */
describe('transcribeLocally', () => {
  it('sends the spoken languages and parses a transcript', async () => {
    const invoke = vi.fn().mockResolvedValue({
      outcome: 'transcribed',
      text: 'Hello.',
      segments: [{ startMs: 0, endMs: 1200, text: 'Hello.' }],
    })
    setBridge({ invoke, listen: async () => () => {} })

    await expect(transcribeLocally(INPUT)).resolves.toEqual({
      outcome: 'transcribed',
      text: 'Hello.',
      segments: [{ startMs: 0, endMs: 1200, text: 'Hello.' }],
    })
    expect(invoke).toHaveBeenCalledWith('local_transcription_transcribe', { request: INPUT })
  })

  it('sends an empty hint as null', async () => {
    const invoke = vi.fn().mockResolvedValue({ outcome: 'transcribed', text: '', segments: [] })
    setBridge({ invoke, listen: async () => () => {} })

    await transcribeLocally({ ...INPUT, languages: [], prompt: '' })
    expect(invoke).toHaveBeenCalledWith('local_transcription_transcribe', {
      request: { ...INPUT, languages: [], prompt: null },
    })
  })

  it('parses an undecodable recording', async () => {
    const invoke = vi.fn().mockResolvedValue({ outcome: 'undecodable', reason: 'no audio' })
    setBridge({ invoke, listen: async () => () => {} })

    await expect(transcribeLocally(INPUT)).resolves.toEqual({
      outcome: 'undecodable',
      reason: 'no audio',
    })
  })
})
