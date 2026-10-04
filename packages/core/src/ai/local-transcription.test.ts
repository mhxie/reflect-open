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
  language: '',
  prompt: 'Names: Ocavue',
} as const

/** The Rust side pins the same shapes in `local_transcription::tests`. */
describe('transcribeLocally', () => {
  it('sends empty settings as null and parses a transcript', async () => {
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
    expect(invoke).toHaveBeenCalledWith('local_transcription_transcribe', {
      request: { ...INPUT, language: null },
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
