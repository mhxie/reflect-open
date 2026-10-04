import { useDeferredValue, type ReactElement } from 'react'
import { HISTORY_WITHHELD_NOTICE, type AssistantPart } from '@reflect/core'
import { Bubble, BubbleContent } from '@/components/ui/bubble.tsx'
import { Marker, MarkerContent } from '@/components/ui/marker.tsx'
import { MarkdownPreview } from '@/editor/markdown-preview.tsx'
import { cn } from '@/lib/utils.ts'
import { ChatToolChip } from './chat-tool-chip.tsx'

interface ChatAssistantPartProps {
  part: AssistantPart
  onWikiLinkClick: (options: { target: string; openInNewWindow: boolean }) => void
}

/**
 * One assistant transcript part: live markdown, tool
 * activity, or a notice.
 */
export function ChatAssistantPart({ part, onWikiLinkClick }: ChatAssistantPartProps): ReactElement {
  switch (part.kind) {
    case 'text':
      return <ChatAssistantText text={part.text} onWikiLinkClick={onWikiLinkClick} />
    case 'tool':
      return <ChatToolChip part={part} />
    case 'notice':
      return <ChatNotice tone={part.tone} text={part.text} />
    case 'history-withheld':
      return <ChatNotice tone="info" text={HISTORY_WITHHELD_NOTICE} />
  }
}

interface ChatNoticeProps {
  tone: 'error' | 'info'
  text: string
}

function ChatNotice({ tone, text }: ChatNoticeProps): ReactElement {
  return (
    <Marker
      className={cn(
        'reflect-chat-message text-sm',
        tone === 'error' ? 'text-destructive' : 'text-text-muted italic',
      )}
    >
      <MarkerContent>{text}</MarkerContent>
    </Marker>
  )
}

/**
 * Streamed deltas can arrive faster than a long code block re-highlights, so
 * the markdown renders from a deferred value: React drops the intermediate
 * renders instead of queueing them.
 *
 * The markdown is model output, which a prompt-injected note can steer, so it
 * renders without remote embeds: otherwise an image URL in an answer could
 * carry note content to any server the moment the answer renders.
 */
function ChatAssistantText({
  text,
  onWikiLinkClick,
}: {
  text: string
  onWikiLinkClick: ChatAssistantPartProps['onWikiLinkClick']
}): ReactElement {
  const content = useDeferredValue(text)
  return (
    <Bubble variant="ghost" className="max-w-full">
      <BubbleContent className="max-w-full text-text">
        <MarkdownPreview
          content={content}
          onWikiLinkClick={onWikiLinkClick}
          remoteEmbeds={false}
          className="reflect-chat-message text-sm"
        />
      </BubbleContent>
    </Bubble>
  )
}
