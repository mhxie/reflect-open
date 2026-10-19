import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { AppError } from '../errors.ts'
import { audioMemoIdentity, audioMemoPartPath } from './audio-memo.ts'
import { APP_REVIEW_STUB_KEY } from '../ai/app-review-demo.ts'
import { TranscriptionRejectedError } from '../ai/transcribe-http.ts'
import type { TestNoteFileService } from '../testing/index.ts'
import {
  ANTHROPIC_CONFIG,
  ANTHROPIC_KEY,
  createAudioMemoTestKit,
  DAILY,
  MEMO,
  NO_PROVIDERS,
  OPENAI_CONFIG,
  OPENAI_KEY,
  PROVIDERS,
  type AudioMemoTestKit,
} from './audio-memo-test-kit.ts'

const DONE = { pending: 1, transcribed: 1, rejected: 0, stopped: null }
const NOTHING = { pending: 0, transcribed: 0, rejected: 0, stopped: null }

const WITH_ANTHROPIC_DEFAULT = {
  providers: [...PROVIDERS.providers, ANTHROPIC_CONFIG],
  defaultProviderId: ANTHROPIC_CONFIG.id,
}

const OPENAI_ENRICHMENT = {
  config: { ...OPENAI_CONFIG, model: 'gpt-5.4-nano' },
  apiKey: 'sk-live-key',
}

afterEach(() => {
  vi.useRealTimers()
})

/**
 * Stage a concurrent change to the day's note that Rust refuses: just before
 * each of the next `times` daily writes lands, a missing daily appears with
 * `edit(undefined)` (a sync pull bringing it), or an existing one disappears
 * because `edit` returns `null`. Returns the spy on `noteFile.write`.
 */
function raceDailyWrites(
  kit: AudioMemoTestKit,
  edit: (current: string | undefined) => string | null,
  times: number,
): MockInstance<TestNoteFileService['write']> {
  const write = kit.noteFile.write.bind(kit.noteFile)
  let remaining = times
  return vi
    .spyOn(kit.noteFile, 'write')
    .mockImplementation(async (path, contents, generation, expected) => {
      if (remaining > 0 && path === DAILY) {
        remaining -= 1
        const next = edit(kit.noteFile.files().get(DAILY))
        if (next === null) {
          await kit.noteFile.delete(DAILY, generation)
        } else {
          kit.noteFile.set(DAILY, next)
        }
      }
      return await write(path, contents, generation, expected)
    })
}

/**
 * Stage a concurrent daily edit that Rust merges: the next daily write lands
 * as `merge(contents)` and reports it as `merged`. Returns the spy on
 * `noteFile.write`.
 */
function mergeNextDailyWrite(
  kit: AudioMemoTestKit,
  merge: (contents: string) => string,
): MockInstance<TestNoteFileService['write']> {
  const write = kit.noteFile.write.bind(kit.noteFile)
  let pending = true
  return vi
    .spyOn(kit.noteFile, 'write')
    .mockImplementation(async (path, contents, generation, expected) => {
      if (pending && path === DAILY) {
        pending = false
        kit.noteFile.mergeNextWrite(DAILY, merge(contents))
      }
      return await write(path, contents, generation, expected)
    })
}

describe('AudioMemoTranscriptionService.reconcile', () => {
  it('does nothing when every memo already has its transcription note', async () => {
    const kit = await createAudioMemoTestKit()
    kit.addRecording(MEMO.audioPath)
    kit.noteFile.set(MEMO.notePath, '# Done\n')

    const onPending = vi.fn()
    const outcome = await kit.reconcile({ onPending })

    expect(outcome).toEqual(NOTHING)
    expect(onPending).toHaveBeenCalledWith(0)
    expect(kit.transcription.calls()).toEqual([])
    expect(kit.getSecretMock).not.toHaveBeenCalled()
  })

  it('ignores stray files in audio-memos/ that are not memo recordings', async () => {
    const kit = await createAudioMemoTestKit()
    kit.addRecording('audio-memos/voice-note.mp3')

    expect(await kit.reconcile()).toEqual(NOTHING)
    expect(kit.transcription.calls()).toEqual([])
  })

  it('transcribes a pending memo, writes the note, then backlinks the daily note', async () => {
    const kit = await createAudioMemoTestKit()
    kit.addRecording(MEMO.audioPath)

    const outcome = await kit.reconcile()

    expect(outcome).toEqual(DONE)
    expect(kit.getSecretMock).toHaveBeenCalledWith('ai-api-key:cfg-openai')
    expect(kit.readBytesMock).toHaveBeenCalledWith(MEMO.audioPath, 3)
    const [request] = kit.transcription.calls()
    expect(request).toMatchObject({
      provider: 'openai',
      apiKey: 'sk-live-key',
      mimeType: 'audio/webm',
    })
    expect(new TextDecoder().decode(await request?.audio.arrayBuffer())).toBe('audio-bytes')
    // The note lands first — it carries the transcript; the backlink follows.
    // The link targets the base (unique per recording), resolved through the
    // note's frontmatter alias; the title alone repeats within a second.
    expect(kit.noteFile.writes()).toEqual([
      {
        path: MEMO.notePath,
        contents:
          '---\naliases: [audio-memo-2026-06-11-153022-845]\n---\n\n# Memo Transcript\n\nmemo transcript\n\n[Recording](audio-memos/audio-memo-2026-06-11-153022-845.webm)\n',
        generation: 3,
      },
      {
        path: DAILY,
        contents:
          'morning thoughts\n\n## [[Audio memos]]\n\n- [[audio-memo-2026-06-11-153022-845|Memo Transcript]]\n',
        generation: 3,
      },
    ])
    expect(kit.ensureBacklinkTargetMock).toHaveBeenCalledWith('Audio memos', 3)
    expect(kit.enrichMock).toHaveBeenCalledWith({
      transcript: 'memo transcript',
      enrichmentCredentials: OPENAI_ENRICHMENT,
      formatTranscript: false,
      fallbackTitle: 'Audio memo 2026-06-11 15:30:22',
    })
  })

  it('caches the transcript of every segment it transcribes', async () => {
    const kit = await createAudioMemoTestKit()
    kit.addRecording(MEMO.audioPath)

    await kit.reconcile()

    expect([...kit.assetStore.transcripts()]).toEqual([
      ['audio-memo-2026-06-11-153022-845.webm.json', '{"text":"memo transcript"}'],
    ])
  })

  it('passes the transcription hint to every segment call', async () => {
    const kit = await createAudioMemoTestKit()
    kit.addRecording(MEMO.audioPath)

    await kit.reconcile({ transcriptionPrompt: 'Names: Ocavue' })

    expect(kit.transcription.calls()[0]?.prompt).toBe('Names: Ocavue')
  })

  it('formats and names a fresh transcript in one best-effort AI pass when enabled', async () => {
    const kit = await createAudioMemoTestKit()
    kit.addRecording(MEMO.audioPath)
    kit.enrichMock.mockResolvedValue({
      title: 'Planning the launch',
      body: 'We reviewed the launch.\n\n## Next steps\n\n- Invite beta users',
    })

    const outcome = await kit.reconcile({ formatTranscript: true })

    expect(outcome).toEqual(DONE)
    expect(kit.enrichMock).toHaveBeenCalledWith({
      transcript: 'memo transcript',
      enrichmentCredentials: OPENAI_ENRICHMENT,
      formatTranscript: true,
      fallbackTitle: 'Audio memo 2026-06-11 15:30:22',
    })
    expect(kit.noteFile.getWrites(MEMO.notePath)[0]).toContain(
      '# Planning the launch\n\nWe reviewed the launch.\n\n## Next steps\n\n- Invite beta users\n\n[Recording](audio-memos/audio-memo-2026-06-11-153022-845.webm)\n',
    )
    expect(kit.noteFile.getWrites(DAILY)[0]).toContain(
      '- [[audio-memo-2026-06-11-153022-845|Planning the launch]]',
    )
  })

  it('uses the default Anthropic Haiku entry to name a memo when configured', async () => {
    const kit = await createAudioMemoTestKit({ providers: WITH_ANTHROPIC_DEFAULT })
    kit.addRecording(MEMO.audioPath)
    await kit.secrets.set(ANTHROPIC_KEY, 'sk-ant-live-key')

    await kit.reconcile()

    expect(kit.getSecretMock).toHaveBeenCalledWith('ai-api-key:cfg-openai')
    expect(kit.getSecretMock).toHaveBeenCalledWith('ai-api-key:cfg-anthropic')
    expect(kit.enrichMock).toHaveBeenCalledWith(
      expect.objectContaining({
        enrichmentCredentials: {
          config: { ...ANTHROPIC_CONFIG, model: 'claude-haiku-4-5' },
          apiKey: 'sk-ant-live-key',
        },
      }),
    )
  })

  it('uses the working transcription key when the preferred enrichment key is missing', async () => {
    const kit = await createAudioMemoTestKit({ providers: WITH_ANTHROPIC_DEFAULT })
    kit.addRecording(MEMO.audioPath)
    await kit.secrets.delete(ANTHROPIC_KEY)

    await kit.reconcile({ formatTranscript: true })

    expect(kit.enrichMock).toHaveBeenCalledWith(
      expect.objectContaining({ enrichmentCredentials: OPENAI_ENRICHMENT }),
    )
  })

  it('a provider-refused recording is tombstoned with a failure note; the pass continues', async () => {
    const kit = await createAudioMemoTestKit()
    const earlier = audioMemoIdentity(new Date(2026, 5, 10, 9, 0, 0, 0), 'audio/mp4')
    kit.addRecording(MEMO.audioPath)
    kit.addRecording(earlier.audioPath)
    let call = 0
    kit.transcription.setResult(() => {
      call += 1
      if (call === 1) {
        throw new TranscriptionRejectedError('openai rejected the recording (413): too large')
      }
      return 'second transcript'
    })

    const outcome = await kit.reconcile()

    expect(outcome).toEqual({ pending: 2, transcribed: 1, rejected: 1, stopped: null })
    expect(kit.noteFile.getWrites(earlier.notePath)[0]).toContain(
      'Transcription failed: openai rejected the recording (413): too large',
    )
    expect(kit.noteFile.getWrites(MEMO.notePath)[0]).toContain('second transcript')
    expect(kit.ensureBacklinkTargetMock).toHaveBeenCalledTimes(1)
  })

  it('a failed note write stops before the backlink — the transcript is never tombstoned away', async () => {
    const kit = await createAudioMemoTestKit()
    kit.addRecording(MEMO.audioPath)
    const createMock = vi
      .spyOn(kit.noteFile, 'create')
      .mockRejectedValue(new AppError('io', 'disk full'))
    const writeMock = vi.spyOn(kit.noteFile, 'write')

    const outcome = await kit.reconcile()

    expect(outcome).toEqual({
      pending: 1,
      transcribed: 0,
      rejected: 0,
      stopped: { reason: 'io', message: 'disk full' },
    })
    // Only the note write was attempted: no backlink means no tombstone, so
    // the next pass retries this memo instead of dropping its transcript.
    expect(createMock).toHaveBeenCalledTimes(1)
    expect(createMock.mock.calls[0]?.[0]).toBe(MEMO.notePath)
    expect(writeMock).not.toHaveBeenCalled()
  })

  it('transcribes on-device in place: no asset read, no provider call, timed segments cached', async () => {
    const kit = await createAudioMemoTestKit()
    kit.addRecording(MEMO.audioPath)
    const transcribeLocally = vi.spyOn(kit.localTranscription, 'transcribe').mockResolvedValue({
      outcome: 'transcribed',
      text: 'local transcript',
      segments: [{ startMs: 0, endMs: 1500, text: 'local transcript' }],
    })

    const outcome = await kit.reconcile({
      engine: 'local',
      transcriptionLanguages: ['en', 'zh'],
      transcriptionPrompt: 'Names: Ocavue',
      formatTranscript: true,
    })

    expect(outcome).toEqual(DONE)
    expect(transcribeLocally).toHaveBeenCalledWith({
      path: MEMO.audioPath,
      generation: 3,
      model: 'large-v3-turbo',
      languages: ['en', 'zh'],
      prompt: 'Names: Ocavue',
    })
    expect(kit.readBytesMock).not.toHaveBeenCalled()
    expect(kit.transcription.calls()).toEqual([])
    expect([...kit.assetStore.transcripts()]).toEqual([
      [
        'audio-memo-2026-06-11-153022-845.webm.json',
        JSON.stringify({
          text: 'local transcript',
          segments: [{ startMs: 0, endMs: 1500, text: 'local transcript' }],
        }),
      ],
    ])
    expect(kit.noteFile.getWrites(MEMO.notePath)[0]).toContain('\n\nlocal transcript\n')
    // Nothing leaves the device: no text model gets the transcript, and the
    // title is derived locally even with a provider and auto-format configured.
    expect(kit.enrichMock).toHaveBeenCalledWith(
      expect.objectContaining({ enrichmentCredentials: null }),
    )
    expect(kit.getSecretMock).not.toHaveBeenCalled()
  })

  it('leaves memos pending while the on-device model is not downloaded', async () => {
    const kit = await createAudioMemoTestKit()
    kit.addRecording(MEMO.audioPath)
    vi.spyOn(kit.localTranscription, 'status').mockResolvedValue({ status: 'missing' })
    const transcribeLocally = vi.spyOn(kit.localTranscription, 'transcribe')

    const outcome = await kit.reconcile({ engine: 'local' })

    expect(outcome).toEqual({
      pending: 1,
      transcribed: 0,
      rejected: 0,
      stopped: {
        reason: 'config',
        message: 'The on-device transcription model is not downloaded.',
      },
    })
    expect(transcribeLocally).not.toHaveBeenCalled()
    expect(kit.noteFile.writes()).toEqual([])
  })

  it('sends the spoken-language choice to the cloud provider', async () => {
    const kit = await createAudioMemoTestKit()
    kit.addRecording(MEMO.audioPath)
    const status = vi.spyOn(kit.localTranscription, 'status')

    await kit.reconcile({ transcriptionLanguages: ['ja'] })

    expect(kit.transcription.calls()[0]?.languages).toEqual(['ja'])
    expect(status).not.toHaveBeenCalled()
  })

  it.each(['cloud', 'local'] as const)(
    'skips a recording the graph refuses to read (%s) and continues, writing nothing about it',
    async (engine) => {
      const kit = await createAudioMemoTestKit()
      const earlier = audioMemoIdentity(new Date(2026, 5, 10, 9, 0, 0, 0), 'audio/mp4')
      const earlierName = earlier.audioPath.slice(earlier.audioPath.lastIndexOf('/') + 1)
      kit.addRecording(MEMO.audioPath)
      kit.addRecording(earlier.audioPath)
      const refused = new AppError(
        'traversal',
        `local-only notes and files never leave this machine: ${earlier.audioPath}`,
      )
      if (engine === 'cloud') {
        kit.readBytesMock.mockRejectedValueOnce(refused)
      } else {
        vi.spyOn(kit.localTranscription, 'transcribe').mockRejectedValueOnce(refused)
      }

      const outcome = await kit.reconcile({ engine })

      expect(outcome).toEqual({ pending: 2, transcribed: 1, rejected: 0, stopped: null })
      expect(kit.noteFile.files().has(MEMO.notePath)).toBe(true)
      for (const write of kit.noteFile.writes()) {
        expect(write.path).not.toBe(earlier.notePath)
        expect(write.contents).not.toContain(earlierName)
      }
      for (const name of kit.assetStore.transcripts().keys()) {
        expect(name).not.toContain(earlierName)
      }
    },
  )

  it('a pause in sharing still stops the pass instead of skipping the recording', async () => {
    const kit = await createAudioMemoTestKit()
    kit.addRecording(MEMO.audioPath)
    kit.readBytesMock.mockRejectedValueOnce(new AppError('io', 'Sharing is paused'))

    const outcome = await kit.reconcile()

    expect(outcome).toEqual({
      pending: 1,
      transcribed: 0,
      rejected: 0,
      stopped: { reason: 'io', message: 'Sharing is paused' },
    })
    expect(kit.noteFile.writes()).toEqual([])
  })

  it('creates the daily note when the day has none yet', async () => {
    const kit = await createAudioMemoTestKit()
    kit.addRecording(MEMO.audioPath)
    await kit.noteFile.delete(DAILY, 3)

    await kit.reconcile()

    expect(kit.noteFile.getWrites(DAILY)).toEqual([
      '## [[Audio memos]]\n\n- [[audio-memo-2026-06-11-153022-845|Memo Transcript]]\n',
    ])
  })

  it('upgrades the legacy plain memo heading without creating a second section', async () => {
    const kit = await createAudioMemoTestKit()
    kit.addRecording(MEMO.audioPath)
    kit.noteFile.set(DAILY, '## Audio memos\n\n- [[audio-memo-2026-06-10-090000-000|Yesterday]]\n')

    await kit.reconcile()

    expect(kit.noteFile.getWrites(DAILY)).toEqual([
      '## [[Audio memos]]\n\n- [[audio-memo-2026-06-10-090000-000|Yesterday]]\n- [[audio-memo-2026-06-11-153022-845|Memo Transcript]]\n',
    ])
  })

  it('extends only the leading memo list, before later daily-note prose', async () => {
    const kit = await createAudioMemoTestKit()
    kit.addRecording(MEMO.audioPath)
    kit.noteFile.set(
      DAILY,
      '## [[Audio memos]]\n\n- [[audio-memo-2026-06-10-090000-000|Yesterday]]\n\nScratchpad for later.\n',
    )

    await kit.reconcile()

    expect(kit.noteFile.getWrites(DAILY)).toEqual([
      '## [[Audio memos]]\n\n- [[audio-memo-2026-06-10-090000-000|Yesterday]]\n- [[audio-memo-2026-06-11-153022-845|Memo Transcript]]\n\nScratchpad for later.\n',
    ])
  })

  it('uses the current title when the Audio memos note was renamed', async () => {
    const kit = await createAudioMemoTestKit()
    kit.addRecording(MEMO.audioPath)
    kit.ensureBacklinkTargetMock.mockResolvedValue('Voice notes')

    await kit.reconcile()

    expect(kit.noteFile.getWrites(DAILY)[0]).toContain('## [[Voice notes]]')
  })

  it('stops before writing the transcript when the category note cannot be ensured', async () => {
    const kit = await createAudioMemoTestKit()
    kit.addRecording(MEMO.audioPath)
    kit.ensureBacklinkTargetMock.mockRejectedValue(new AppError('io', 'disk full'))

    const outcome = await kit.reconcile()

    expect(outcome).toEqual({
      pending: 1,
      transcribed: 0,
      rejected: 0,
      stopped: { reason: 'io', message: 'disk full' },
    })
    expect(kit.noteFile.writes()).toEqual([])
    expect(kit.transcription.calls()).toHaveLength(1)
  })

  it('a daily-note backlink without the note is a tombstone — deletion stays deleted', async () => {
    const kit = await createAudioMemoTestKit()
    kit.addRecording(MEMO.audioPath)
    kit.noteFile.set(DAILY, 'notes\n\n[[audio-memo-2026-06-11-153022-845|Audio memo 15:30]]\n')

    const onPending = vi.fn()
    const outcome = await kit.reconcile({ onPending })

    expect(outcome).toEqual(NOTHING)
    expect(onPending).toHaveBeenCalledWith(0)
    expect(kit.transcription.calls()).toEqual([])
    expect(kit.noteFile.writes()).toEqual([])
  })

  it("a same-second sibling backlink is not this memo's tombstone", async () => {
    // Same second, different milliseconds: identical display titles, distinct
    // bases. The earlier sibling is fully done; the later one must still run.
    const kit = await createAudioMemoTestKit()
    const sibling = audioMemoIdentity(new Date(2026, 5, 11, 15, 30, 22, 100), 'audio/webm')
    kit.addRecording(sibling.audioPath)
    kit.addRecording(MEMO.audioPath)
    kit.noteFile.set(sibling.notePath, '# Sibling\n')
    kit.noteFile.set(DAILY, `notes\n\n[[${sibling.base}|Audio memo 15:30]]\n`)

    const outcome = await kit.reconcile()

    expect(outcome).toEqual(DONE)
    expect(kit.noteFile.getWrites(MEMO.notePath)[0]).toContain('memo transcript')
  })

  it('an empty transcript writes a placeholder note — silence must not retry forever', async () => {
    const kit = await createAudioMemoTestKit()
    kit.addRecording(MEMO.audioPath)
    kit.transcription.setResult('')

    const outcome = await kit.reconcile({ formatTranscript: true })

    expect(outcome).toEqual(DONE)
    expect(kit.enrichMock).not.toHaveBeenCalled()
    expect(kit.noteFile.getWrites(MEMO.notePath)[0]).toContain('No speech detected.')
  })

  it('transcribes oldest first, regardless of listing order', async () => {
    const kit = await createAudioMemoTestKit()
    const earlier = audioMemoIdentity(new Date(2026, 5, 10, 9, 0, 0, 0), 'audio/mp4')
    kit.addRecording(MEMO.audioPath)
    kit.addRecording(earlier.audioPath)

    await kit.reconcile()

    expect(kit.readBytesMock.mock.calls.map(([path]) => path)).toEqual([
      earlier.audioPath,
      MEMO.audioPath,
    ])
    expect(kit.readTranscriptCacheMock.mock.calls.map(([name]) => name)).toEqual([
      'audio-memo-2026-06-10-090000-000.m4a.json',
      'audio-memo-2026-06-11-153022-845.webm.json',
    ])
  })

  it('stops the pass on the first failure — the rest would fail the same way', async () => {
    const kit = await createAudioMemoTestKit()
    const earlier = audioMemoIdentity(new Date(2026, 5, 10, 9, 0, 0, 0), 'audio/mp4')
    kit.addRecording(earlier.audioPath)
    kit.addRecording(MEMO.audioPath)
    kit.transcription.setResult(() => Promise.reject(new AppError('network', 'provider down')))

    const outcome = await kit.reconcile({ formatTranscript: true })

    expect(outcome).toEqual({
      pending: 2,
      transcribed: 0,
      rejected: 0,
      stopped: { reason: 'network', message: 'provider down' },
    })
    expect(kit.transcription.calls()).toHaveLength(1)
    expect(kit.noteFile.writes()).toEqual([])
  })

  it('a memo that failed to transcribe drains on the next pass — e.g. the next app launch', async () => {
    const kit = await createAudioMemoTestKit()
    kit.addRecording(MEMO.audioPath)
    kit.transcription.setResult(() => Promise.reject(new AppError('network', 'offline')))

    const offline = await kit.reconcile()

    expect(offline).toMatchObject({ pending: 1, transcribed: 0, stopped: { reason: 'network' } })
    expect(kit.noteFile.writes()).toEqual([])

    // Nothing about the pending memo lives in memory: a later pass — the next
    // trigger, or the mount pass after an app restart — recomputes it from
    // the same on-disk state and drains it.
    kit.transcription.setResult('memo transcript')
    const relaunched = await kit.reconcile()

    expect(relaunched).toEqual(DONE)
    expect(kit.noteFile.getWrites(MEMO.notePath)[0]).toContain('memo transcript')
    expect(kit.noteFile.getWrites(DAILY)[0]).toContain(
      '- [[audio-memo-2026-06-11-153022-845|Memo Transcript]]',
    )
  })

  it('uses the timestamp fallback name for silence', async () => {
    const kit = await createAudioMemoTestKit()
    kit.addRecording(MEMO.audioPath)
    kit.transcription.setResult('')

    const outcome = await kit.reconcile()

    expect(outcome).toEqual(DONE)
    expect(kit.enrichMock).not.toHaveBeenCalled()
    expect(kit.noteFile.getWrites(MEMO.notePath)[0]).toContain('# Audio memo 2026-06-11 15:30:22')
    expect(kit.noteFile.getWrites(DAILY)[0]).toContain(
      '- [[audio-memo-2026-06-11-153022-845|Audio memo 2026-06-11 15:30:22]]',
    )
  })

  it('reports a missing provider as config — the pass retries after settings change', async () => {
    const kit = await createAudioMemoTestKit({ providers: NO_PROVIDERS })
    kit.addRecording(MEMO.audioPath)

    const outcome = await kit.reconcile()

    expect(outcome).toMatchObject({ pending: 1, transcribed: 0, stopped: { reason: 'config' } })
    expect(kit.getSecretMock).not.toHaveBeenCalled()
  })

  it('reports a missing keychain entry as config', async () => {
    const kit = await createAudioMemoTestKit()
    kit.addRecording(MEMO.audioPath)
    await kit.secrets.delete(OPENAI_KEY)
    await kit.secrets.delete(ANTHROPIC_KEY)

    const outcome = await kit.reconcile()

    expect(outcome).toMatchObject({ pending: 1, stopped: { reason: 'config' } })
    expect(outcome.stopped?.message).toMatch(/keychain/)
    expect(kit.transcription.calls()).toEqual([])
  })

  it('the abort gate stops between memos', async () => {
    const kit = await createAudioMemoTestKit()
    const earlier = audioMemoIdentity(new Date(2026, 5, 10, 9, 0, 0, 0), 'audio/mp4')
    kit.addRecording(earlier.audioPath)
    kit.addRecording(MEMO.audioPath)
    // The first memo checks at loop start, at its segment loop, after the
    // asset read, after the provider call, after category resolution, and
    // before the note write; stop at the next loop start.
    const isStale = vi
      .fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValue(true)

    const outcome = await kit.reconcile({ isStale })

    expect(outcome).toMatchObject({ pending: 2, transcribed: 1, stopped: { reason: 'stale' } })
    expect(kit.transcription.calls()).toHaveLength(1)
  })

  it('a graph switch during transcription stops before any write', async () => {
    const kit = await createAudioMemoTestKit()
    kit.addRecording(MEMO.audioPath)
    let closed = false
    kit.transcription.setResult(() => {
      closed = true // the switch lands while the provider call is in flight
      return 'memo transcript'
    })

    const outcome = await kit.reconcile({ isStale: () => closed })

    expect(outcome).toMatchObject({ pending: 1, transcribed: 0, stopped: { reason: 'stale' } })
    expect(kit.enrichMock).not.toHaveBeenCalled()
    expect(kit.noteFile.writes()).toEqual([])
  })

  it('a graph switch during formatting stops before any write', async () => {
    const kit = await createAudioMemoTestKit()
    kit.addRecording(MEMO.audioPath)
    let closed = false
    kit.enrichMock.mockImplementation(() => {
      closed = true
      return Promise.resolve({ title: 'Formatted title', body: 'Formatted transcript' })
    })

    const outcome = await kit.reconcile({ formatTranscript: true, isStale: () => closed })

    expect(outcome).toMatchObject({ pending: 1, transcribed: 0, stopped: { reason: 'stale' } })
    expect(kit.enrichMock).toHaveBeenCalledTimes(1)
    expect(kit.noteFile.writes()).toEqual([])
  })

  it('a graph switch during category resolution stops before any note write', async () => {
    const kit = await createAudioMemoTestKit()
    kit.addRecording(MEMO.audioPath)
    let closed = false
    kit.ensureBacklinkTargetMock.mockImplementation(() => {
      closed = true
      return 'Audio memos'
    })

    const outcome = await kit.reconcile({ isStale: () => closed })

    expect(outcome).toMatchObject({ pending: 1, transcribed: 0, stopped: { reason: 'stale' } })
    expect(kit.noteFile.writes()).toEqual([])
  })

  it('a listing failure is reported, never thrown — reconcile runs unattended', async () => {
    const kit = await createAudioMemoTestKit()
    vi.spyOn(kit.noteFile, 'listDir').mockRejectedValue(new AppError('noGraph', 'no graph open'))

    expect(await kit.reconcile()).toEqual({
      pending: 0,
      transcribed: 0,
      rejected: 0,
      stopped: { reason: 'noGraph', message: 'no graph open' },
    })
  })

  it('rethrows daily-note read failures other than notFound — never writes blind', async () => {
    const kit = await createAudioMemoTestKit()
    kit.addRecording(MEMO.audioPath)
    vi.spyOn(kit.noteFile, 'read').mockRejectedValue(new AppError('io', 'disk gone'))

    const outcome = await kit.reconcile()

    expect(outcome).toMatchObject({ stopped: { reason: 'io', message: 'disk gone' } })
    expect(kit.noteFile.writes()).toEqual([])
  })
})

describe('AudioMemoTranscriptionService.reconcile never writes over a concurrent writer', () => {
  it('keeps another device’s transcript byte-identical, adds no backlink, and moves on', async () => {
    const kit = await createAudioMemoTestKit()
    const earlier = audioMemoIdentity(new Date(2026, 5, 10, 9, 0, 0, 0), 'audio/mp4')
    kit.addRecording(earlier.audioPath)
    kit.addRecording(MEMO.audioPath)
    const theirs = `---\naliases: [${earlier.base}]\n---\n\n# Transcribed on the phone\n`
    // The other device's note lands while this pass waits on the enrichment call.
    kit.enrichMock.mockImplementationOnce((input) => {
      kit.noteFile.set(earlier.notePath, theirs)
      return Promise.resolve({ title: 'Memo Transcript', body: input.transcript })
    })

    const outcome = await kit.reconcile()

    expect(outcome).toEqual({ pending: 2, transcribed: 1, rejected: 0, stopped: null })
    expect(kit.noteFile.files().get(earlier.notePath)).toBe(theirs)
    expect(kit.noteFile.files().has('daily/2026-06-10.md')).toBe(false)
    expect(kit.noteFile.files().get(MEMO.notePath)).toContain('memo transcript')
    expect(kit.noteFile.files().get(DAILY)).toContain(`[[${MEMO.base}|Memo Transcript]]`)
  })

  it('a demo-key pass that collides also leaves the existing file intact', async () => {
    const kit = await createAudioMemoTestKit()
    await kit.secrets.set(OPENAI_KEY, APP_REVIEW_STUB_KEY)
    kit.addRecording(MEMO.audioPath)
    const theirs = '# Transcribed on the phone\n'
    kit.ensureBacklinkTargetMock.mockImplementation(() => {
      kit.noteFile.set(MEMO.notePath, theirs)
      return 'Audio memos'
    })

    const outcome = await kit.reconcile()

    expect(outcome).toEqual({ pending: 1, transcribed: 0, rejected: 0, stopped: null })
    expect(kit.noteFile.files().get(MEMO.notePath)).toBe(theirs)
    expect(kit.noteFile.files().get(DAILY)).toBe('morning thoughts\n')
  })

  it('keeps a daily edit that Rust merged with the backlink, writing it once', async () => {
    const kit = await createAudioMemoTestKit()
    kit.addRecording(MEMO.audioPath)
    const write = mergeNextDailyWrite(kit, (contents) => {
      return contents.replace('morning thoughts\n', 'morning thoughts\nlunch with Ada\n')
    })

    const outcome = await kit.reconcile()

    expect(outcome).toEqual(DONE)
    const daily = kit.noteFile.files().get(DAILY) ?? ''
    expect(daily).toContain('lunch with Ada')
    expect(daily.split(`[[${MEMO.base}|`)).toHaveLength(2) // exactly one backlink
    // The merged write landed: nothing is read back and written again.
    expect(write.mock.calls.filter(([path]) => path === DAILY)).toHaveLength(1)
  })

  it('keeps a daily note that appeared between read and write, with exactly one backlink', async () => {
    const kit = await createAudioMemoTestKit()
    await kit.noteFile.delete(DAILY, 3)
    kit.addRecording(MEMO.audioPath)
    raceDailyWrites(kit, () => 'lunch with Ada\n', 1)

    const outcome = await kit.reconcile()

    expect(outcome).toEqual(DONE)
    const daily = kit.noteFile.files().get(DAILY) ?? ''
    expect(daily).toContain('lunch with Ada')
    expect(daily.split(`[[${MEMO.base}|`)).toHaveLength(2) // exactly one backlink
  })

  it('stops when the backlink arrived in the race instead of adding a second', async () => {
    const kit = await createAudioMemoTestKit()
    await kit.noteFile.delete(DAILY, 3)
    kit.addRecording(MEMO.audioPath)
    const synced = `## [[Audio memos]]\n\n- [[${MEMO.base}|From the phone]]\n`
    const write = raceDailyWrites(kit, () => synced, 1)

    await kit.reconcile()

    expect(kit.noteFile.files().get(DAILY)).toBe(synced)
    expect(write.mock.calls.filter(([path]) => path === DAILY)).toHaveLength(1)
  })

  it('skips the backlink after losing the race twice, keeping the transcript', async () => {
    const kit = await createAudioMemoTestKit()
    await kit.noteFile.delete(DAILY, 3)
    kit.addRecording(MEMO.audioPath)
    // The day's note is created, then removed, under each write.
    const write = raceDailyWrites(
      kit,
      (daily) => (daily === undefined ? 'edit 1\n' : null),
      Infinity,
    )

    const outcome = await kit.reconcile()

    expect(outcome).toEqual(DONE)
    expect(kit.noteFile.files().get(MEMO.notePath)).toContain('memo transcript')
    expect(kit.noteFile.files().has(DAILY)).toBe(false)
    expect(write.mock.calls.filter(([path]) => path === DAILY)).toHaveLength(2)
  })

  it('a real write failure on the daily note still stops the pass', async () => {
    const kit = await createAudioMemoTestKit()
    kit.addRecording(MEMO.audioPath)
    vi.spyOn(kit.noteFile, 'write').mockRejectedValue(new AppError('io', 'disk full'))

    const outcome = await kit.reconcile()

    expect(outcome.stopped).toEqual({ reason: 'io', message: 'disk full' })
  })
})

describe('AudioMemoTranscriptionService.reconcile with the App Review demo key', () => {
  /**
   * 2026-06-12 09:00:00 local: the moment the canned transcript stamps.
   */
  const DEMO_NOW = new Date(2026, 5, 12, 9, 0, 0, 0)
  const DEMO_BODY =
    "This is a demo transcription produced by Reflect's App Review demo key. " +
    'No audio left the device and no AI provider was called.\n\n' +
    `Demo transcript generated at ${DEMO_NOW.toLocaleString()}.`

  async function createDemoKit() {
    const kit = await createAudioMemoTestKit({ providers: WITH_ANTHROPIC_DEFAULT })
    await kit.secrets.set(OPENAI_KEY, APP_REVIEW_STUB_KEY)
    await kit.secrets.set(ANTHROPIC_KEY, APP_REVIEW_STUB_KEY)
    // The canned transcript reads the system date, not the clock service.
    vi.useFakeTimers({ toFake: ['Date'], now: DEMO_NOW })
    return kit
  }

  it('writes one canned note under the timestamp title, without reading any segment', async () => {
    const kit = await createDemoKit()
    kit.addRecording(MEMO.audioPath)

    const outcome = await kit.reconcile({ formatTranscript: true })

    expect(outcome).toEqual(DONE)
    expect(kit.noteFile.writes()).toEqual([
      {
        path: MEMO.notePath,
        contents: `---\naliases: [audio-memo-2026-06-11-153022-845]\n---\n\n# Audio memo 2026-06-11 15:30:22\n\n${DEMO_BODY}\n\n[Recording](audio-memos/audio-memo-2026-06-11-153022-845.webm)\n`,
        generation: 3,
      },
      {
        path: DAILY,
        contents:
          'morning thoughts\n\n## [[Audio memos]]\n\n- [[audio-memo-2026-06-11-153022-845|Audio memo 2026-06-11 15:30:22]]\n',
        generation: 3,
      },
    ])
    // No segment read, no provider call, no enrichment, no cache.
    expect(kit.readBytesMock).not.toHaveBeenCalled()
    expect(kit.readTranscriptCacheMock).not.toHaveBeenCalled()
    expect(kit.transcription.calls()).toEqual([])
    expect(kit.enrichMock).not.toHaveBeenCalled()
    expect(kit.assetStore.transcripts().size).toBe(0)
    expect(kit.ensureBacklinkTargetMock).toHaveBeenCalledWith('Audio memos', 3)
  })

  it('writes the canned transcript once for a session of several segments', async () => {
    const kit = await createDemoKit()
    const first = audioMemoPartPath(MEMO, 1, false)
    const last = audioMemoPartPath(MEMO, 2, true)
    kit.addRecording(first)
    kit.addRecording(last)

    const outcome = await kit.reconcile()

    expect(outcome).toEqual(DONE)
    expect(kit.noteFile.getWrites(MEMO.notePath)).toEqual([
      `---\naliases: [audio-memo-2026-06-11-153022-845]\n---\n\n# Audio memo 2026-06-11 15:30:22\n\n${DEMO_BODY}\n\n[Recording](${first}) · [Part 2](${last})\n`,
    ])
    expect(kit.readBytesMock).not.toHaveBeenCalled()
    expect(kit.assetStore.transcripts().size).toBe(0)
  })

  it('leaves a session that is still recording pending', async () => {
    const kit = await createDemoKit()
    kit.addRecording(audioMemoPartPath(MEMO, 1, false), { modifiedMs: kit.clock.now() })

    const outcome = await kit.reconcile()

    expect(outcome).toEqual({ pending: 1, transcribed: 0, rejected: 0, stopped: null })
    expect(kit.noteFile.writes()).toEqual([])
    expect(kit.ensureBacklinkTargetMock).not.toHaveBeenCalled()
  })

  it('the abort gate stops before the canned note is written', async () => {
    const kit = await createDemoKit()
    kit.addRecording(MEMO.audioPath)
    let closed = false
    kit.ensureBacklinkTargetMock.mockImplementation(() => {
      closed = true
      return 'Audio memos'
    })

    const outcome = await kit.reconcile({ isStale: () => closed })

    expect(outcome).toMatchObject({ pending: 1, transcribed: 0, stopped: { reason: 'stale' } })
    expect(kit.noteFile.writes()).toEqual([])
  })
})
