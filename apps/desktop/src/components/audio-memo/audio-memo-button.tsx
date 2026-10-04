import type { ReactElement } from 'react'
import { Square } from 'lucide-react'
import { MicIcon } from '@/components/icons/mic-icon.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import { cn } from '@/lib/utils.ts'
import { useAudioMemo } from '@/providers/audio-memo-provider.tsx'

/**
 * The microphone beside the sidebar search box. Idle it starts a memo;
 * recording it becomes the red stop control (Esc on it discards instead), with
 * the live state in the {@link RecordingStrip} below. While earlier memos are
 * still transcribing the mic stays live — memos queue, so the next recording
 * can start immediately. Disabled (with the reason as a tooltip) when no
 * OpenAI/Gemini model is configured — `aria-disabled` rather than `disabled`
 * so the tooltip still fires.
 */
export function AudioMemoButton(): ReactElement {
  const memo = useAudioMemo()

  if (memo.phase === 'recording' || memo.phase === 'error') {
    const recording = memo.phase === 'recording'
    return (
      <Button
        variant="destructive"
        size="icon-sm"
        className="rounded-full"
        aria-label={recording ? 'Stop recording' : 'Discard audio memo'}
        onClick={() => (recording ? memo.toggle() : memo.discard())}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            if (recording) {
              memo.cancel()
            } else {
              memo.discard()
            }
          }
        }}
      >
        {recording ? (
          <Square aria-hidden fill="currentColor" className="size-3" />
        ) : (
          <MicIcon className="size-5" />
        )}
      </Button>
    )
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Record audio memo"
            aria-disabled={!memo.available || undefined}
            onClick={() => {
              if (memo.available) {
                memo.toggle()
              }
            }}
            className={cn(
              'text-text-muted hover:text-text-secondary dark:hover:text-text',
              !memo.available && 'opacity-50 hover:bg-transparent hover:text-text-muted',
            )}
          >
            <MicIcon className="size-5" />
          </Button>
        }
      />
      <TooltipContent side="bottom">{memo.unavailableReason ?? 'Record audio memo'}</TooltipContent>
    </Tooltip>
  )
}
