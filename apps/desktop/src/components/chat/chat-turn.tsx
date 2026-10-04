import type { ReactElement } from 'react'
import type { ChatTurn as ChatTurnModel } from '@reflect/core'
import { Bubble, BubbleContent } from '@/components/ui/bubble.tsx'
import { Marker, MarkerContent } from '@/components/ui/marker.tsx'
import { Message, MessageContent, MessageFooter, MessageGroup } from '@/components/ui/message.tsx'
import { useWikiLinkNavigation } from '@/editor/use-wiki-link-navigation.ts'
import { assistantReplyMarkdown } from '@/lib/chat-copy.ts'
import { ChatAssistantPart } from './chat-assistant-part.tsx'
import { ChatCopyButton } from './chat-copy-button.tsx'
import { ChatUserAttachments } from './chat-user-attachments.tsx'

interface ChatTurnProps {
  turn: ChatTurnModel
}

/**
 * One conversation turn: the user's message and images render through
 * shadcn chat primitives, followed by assistant text, tool markers, and
 * notices in the order the engine produced them.
 *
 * Assistant text uses the same lightweight, read-only markdown preview while
 * streaming and after completion, including clickable `[[citation]]` chips.
 *
 * Wiki navigation passes a null generation deliberately: a clicked citation
 * that doesn't resolve must never *create* a note the model hallucinated.
 *
 * A settled turn that produced answer text gets a copy button revealed by
 * hovering the response content or focusing the action; a turn that only ran
 * tools or errored has nothing to copy, so it gets none.
 */
export function ChatTurn({ turn }: ChatTurnProps): ReactElement {
  const navigateWikiLink = useWikiLinkNavigation(null)
  const replyMarkdown = turn.status === 'done' ? assistantReplyMarkdown(turn) : null
  // The withheld-history notice arrives before the provider answers, so it
  // must not end the "Thinking…" state the way a first reply part does.
  const awaitingReply =
    turn.status === 'streaming' && turn.parts.every((part) => part.kind === 'history-withheld')

  return (
    <MessageGroup className="gap-6">
      <Message align="end">
        <MessageContent className="items-end gap-2">
          <ChatUserAttachments attachments={turn.attachments} />
          {turn.userText !== '' ? (
            <Bubble align="end" variant="muted" className="max-w-[85%]">
              <BubbleContent className="reflect-chat-message !bg-surface-hover px-4 py-2 leading-normal whitespace-pre-wrap !text-text">
                {turn.userText}
              </BubbleContent>
            </Bubble>
          ) : null}
        </MessageContent>
      </Message>

      <Message align="start">
        <MessageContent className="group/assistant-response w-fit max-w-full gap-2">
          {turn.parts.map((part, index) => (
            <ChatAssistantPart key={index} part={part} onWikiLinkClick={navigateWikiLink} />
          ))}
          {awaitingReply ? (
            <Marker className="animate-pulse text-sm text-text-muted">
              <MarkerContent>Thinking…</MarkerContent>
            </Marker>
          ) : null}
          {replyMarkdown !== null ? (
            <MessageFooter className="pointer-events-none -mt-1 opacity-0 transition-opacity duration-100 group-hover/assistant-response:pointer-events-auto group-hover/assistant-response:opacity-100 group-focus-within/assistant-response:pointer-events-auto group-focus-within/assistant-response:opacity-100">
              <ChatCopyButton text={replyMarkdown} />
            </MessageFooter>
          ) : null}
        </MessageContent>
      </Message>
    </MessageGroup>
  )
}
