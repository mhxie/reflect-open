import { useMemo, type ReactElement } from 'react'
import { CircleCheck, X } from 'lucide-react'
import { isModEvent } from '@meowdown/core'
import { displayNoteTitle } from '@reflect/core'
import {
  RecordingWaveform,
  type WaveformSource,
} from '@/components/audio-memo/recording-waveform.tsx'
import { usePeekNavigation } from '@/components/peek/peek-provider.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Spinner } from '@/components/ui/spinner.tsx'
import { useNoteRow } from '@/hooks/use-note-row.ts'
import { formatRecordingElapsed } from '@/lib/recording-time.ts'
import { useAudioMemo } from '@/providers/audio-memo-provider.tsx'
import { useOptionalRecorder } from '@/providers/recorder-provider.tsx'
import { routeForPath } from '@/routing/route.ts'

const STRIP_CLASS =
  'mx-4 mt-2 flex min-h-8 items-center gap-2 rounded-lg border border-border bg-surface px-2.5 py-1 text-xs shadow-xs'

const DISMISS_CLASS =
  'flex size-5 shrink-0 items-center justify-center rounded text-text-muted hover:bg-surface-hover hover:text-text'

/** The note a finished recording became: opens in Peek, or dismisses. */
function TranscriptReady({
  path,
  onDismiss,
}: {
  path: string
  onDismiss: () => void
}): ReactElement {
  const row = useNoteRow(path)
  const openNote = usePeekNavigation()
  const title =
    row === null ? path.split('/').at(-1)!.replace(/\.md$/, '') : displayNoteTitle(row.title)
  return (
    <div role="status" aria-label="Transcript ready" className={STRIP_CLASS}>
      <CircleCheck aria-hidden strokeWidth={1.75} className="size-3.5 shrink-0 text-accent" />
      <button
        type="button"
        onClick={(event) => {
          openNote({ target: routeForPath(path), openInNewWindow: isModEvent(event) })
          onDismiss()
        }}
        className="flex min-w-0 flex-1 flex-col text-left leading-4 hover:text-text"
      >
        <span className="text-2xs text-text-muted">Transcript ready</span>
        <span className="truncate text-text-secondary">{title}</span>
      </button>
      <button
        type="button"
        aria-label="Dismiss transcript"
        onClick={onDismiss}
        className={DISMISS_CLASS}
      >
        <X aria-hidden className="size-3" strokeWidth={1.75} />
      </button>
    </div>
  )
}

/**
 * The recording's place in the sidebar, after Arc's media controls: a strip
 * under the search box that stays put across pages — the live waveform and
 * time while recording, progress while transcribing, a failure with its
 * remedies, then the transcript note it became.
 */
export function RecordingStrip(): ReactElement | null {
  const memo = useAudioMemo()
  const recorder = useOptionalRecorder()
  const { stream, subscribeLevel } = memo
  const waveformSource = useMemo((): WaveformSource | null => {
    if (stream !== null) {
      return { kind: 'stream', stream }
    }
    return subscribeLevel === null ? null : { kind: 'levels', subscribe: subscribeLevel }
  }, [stream, subscribeLevel])

  switch (memo.phase) {
    case 'recording':
      return (
        <div role="status" aria-label="Recording" className={STRIP_CLASS}>
          <span
            aria-hidden
            className="size-2 shrink-0 rounded-full bg-red-500 motion-safe:animate-pulse"
          />
          <div className="min-w-0 flex-1 overflow-hidden">
            {waveformSource === null ? null : <RecordingWaveform source={waveformSource} />}
          </div>
          <span className="shrink-0 font-medium tabular-nums">
            {formatRecordingElapsed(memo.elapsedMs)}
          </span>
          <button
            type="button"
            aria-label="Discard recording"
            onClick={() => memo.cancel()}
            className={DISMISS_CLASS}
          >
            <X aria-hidden className="size-3" strokeWidth={1.75} />
          </button>
        </div>
      )
    case 'transcribing':
      return (
        <div role="status" aria-label="Transcribing" className={STRIP_CLASS}>
          <Spinner />
          <span className="text-text-muted">Transcribing…</span>
        </div>
      )
    case 'error':
      return (
        <div role="alert" className={`${STRIP_CLASS} flex-wrap py-1.5`}>
          <p className="w-full text-destructive">{memo.error}</p>
          {memo.canRetry ? (
            <Button size="xs" variant="secondary" onClick={() => memo.retry()}>
              Retry
            </Button>
          ) : null}
          <Button size="xs" variant="ghost" onClick={() => memo.discard()}>
            Discard
          </Button>
        </div>
      )
    case 'idle':
    case 'requesting':
      return recorder?.lastTranscript == null ? null : (
        <TranscriptReady path={recorder.lastTranscript} onDismiss={recorder.dismissTranscript} />
      )
  }
}
