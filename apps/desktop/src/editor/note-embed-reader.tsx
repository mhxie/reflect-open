import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from 'react'
import type { NoteEmbedPayload, NoteEmbedRenderer } from '@meowdown/react'
import { ArrowUpRight, ChevronDown, ChevronUp } from 'lucide-react'
import { splitFrontmatter, splitWikiLinkTarget } from '@reflect/core'
import { MarkdownPreview } from '@/editor/markdown-preview.tsx'
import { NoteEmbedBody } from '@/editor/note-embed-body.tsx'
import { revealPreviewHeading } from '@/editor/reveal-preview-heading.ts'
import { useNoteEmbedNavigation } from '@/editor/use-note-embed-navigation.ts'
import { useNoteEmbedSource, type NoteEmbedSourceOptions } from '@/editor/use-note-embed-source.ts'
import { createNoteAttachments } from '@/editor/use-note-attachments.ts'
import { usePreviewOverflow } from '@/hooks/use-preview-overflow.ts'
import { cn } from '@/lib/utils.ts'
import {
  embeddedHeadingElement,
  notifyOutlineEmbed,
  readEmbeddedOutlineBlocks,
  registerOutlineEmbed,
} from '@/editor/outline/outline-embeds.ts'

/** What a host editor passes every embedded-note reader it mounts. */
export interface NoteEmbedReaderOptions extends Omit<NoteEmbedSourceOptions, 'target' | 'enabled'> {
  /** Whether expanded bodies may load remote media (false under any private ancestor). */
  readonly remoteEmbeds: boolean
}

interface NoteEmbedReaderProps extends NoteEmbedReaderOptions, NoteEmbedPayload {}

const FAILURE_LABELS = {
  missing: 'Note not found.',
  ambiguous: 'More than one note matches this link.',
  unavailable: 'This note is not available on this device.',
  cycle: 'This note is already embedded above. Open it to continue reading.',
  limit: 'Open the note to continue reading deeper embeds.',
}

/** A passive excerpt blends into the note; selecting it reads the live full source in place. */
/** Whether the reader's full body (not its preview) is in the DOM yet. */
function renderedExpanded(root: HTMLElement): boolean {
  return root.firstElementChild?.hasAttribute('data-expanded') === true
}

export function NoteEmbedReader(props: NoteEmbedReaderProps): ReactElement {
  const { target, display, sourcePath, generation, graphKey, ancestors, remoteEmbeds } = props
  const [expanded, setExpanded] = useState(false)
  const { source, reload } = useNoteEmbedSource({ ...props, enabled: true })
  const bodyId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const revealed = useRef(false)
  const outlineReveal = useRef<number | null>(null)
  const { setRoot: setPreviewRoot, overflowing } = usePreviewOverflow()
  const path = source.kind === 'ready' ? source.path : sourcePath
  const reveal = useCallback(
    (fragment: string) => {
      if (source.kind === 'ready' && rootRef.current) {
        revealPreviewHeading(rootRef.current, source.source, fragment)
      }
    },
    [source],
  )
  const navigation = useNoteEmbedNavigation({ generation, graphKey, sourcePath: path, reveal })
  const childAncestors = useMemo(() => [...ancestors, path], [ancestors, path])
  const renderNested = useCallback(
    (payload: NoteEmbedPayload, allowRemote: boolean) => (
      <NoteEmbedReader
        key={`${graphKey}:${generation}:${payload.target}`}
        {...payload}
        sourcePath={path}
        generation={generation}
        graphKey={graphKey}
        ancestors={childAncestors}
        remoteEmbeds={allowRemote}
      />
    ),
    [path, generation, graphKey, childAncestors],
  )

  useEffect(() => {
    const { fragment } = splitWikiLinkTarget(target)
    if (expanded && source.kind === 'ready' && !revealed.current && rootRef.current) {
      if (fragment !== null) {
        revealed.current = revealPreviewHeading(rootRef.current, source.source, fragment)
      } else {
        const firstBlock = rootRef.current.querySelector<HTMLElement>('h1, h2, h3, h4, h5, h6, p')
        if (firstBlock !== null) {
          firstBlock.tabIndex = -1
          firstBlock.focus({ preventScroll: true })
          revealed.current = true
        }
      }
    }
  }, [target, expanded, source])

  const label = display || target
  const body = source.kind === 'ready' ? splitFrontmatter(source.source).body : ''
  const outlineBlocks = useMemo(
    () => readEmbeddedOutlineBlocks(body, ancestors.length),
    [body, ancestors.length],
  )
  const requestOutlineReveal = useCallback((ordinal: number) => {
    outlineReveal.current = ordinal
    revealed.current = true
    setExpanded(true)
    const root = rootRef.current
    if (root !== null && renderedExpanded(root)) {
      const heading = embeddedHeadingElement(root, ordinal)
      if (heading !== null) {
        heading.tabIndex = -1
        heading.focus({ preventScroll: true })
        outlineReveal.current = null
      }
    }
  }, [])
  useLayoutEffect(() => {
    const root = rootRef.current
    if (root === null || source.kind !== 'ready') return
    const first = outlineBlocks.find((block) => block.kind === 'heading')
    return registerOutlineEmbed(root, {
      id: bodyId,
      target,
      blocks: outlineBlocks,
      element: (ordinal) => {
        return renderedExpanded(root) || ordinal === first?.ordinal
          ? embeddedHeadingElement(root, ordinal)
          : null
      },
      reveal: requestOutlineReveal,
    })
  }, [bodyId, target, source, outlineBlocks, requestOutlineReveal])
  useLayoutEffect(() => {
    const root = rootRef.current
    if (root === null) return
    if (expanded && outlineReveal.current !== null) {
      const heading = embeddedHeadingElement(root, outlineReveal.current)
      if (heading !== null) {
        heading.tabIndex = -1
        heading.focus({ preventScroll: true })
        outlineReveal.current = null
      }
    }
    notifyOutlineEmbed(root)
  }, [expanded, source])
  const preview = body.slice(0, 4096)
  const previewAttachments = useMemo(
    () => createNoteAttachments(generation, path),
    [generation, path],
  )
  return (
    <div
      ref={rootRef}
      className="group/note-embed relative my-2 min-w-0"
      data-testid="note-embed"
      data-note-embed-outline={bodyId}
      data-note-embed-target={target}
    >
      <div
        id={bodyId}
        ref={expanded ? undefined : setPreviewRoot}
        className={cn(
          'min-w-0',
          !expanded && 'reflect-note-embed-preview',
          !expanded && overflowing && 'reflect-note-embed-preview-overflowing',
        )}
        data-testid={expanded ? 'note-embed-full' : 'note-embed-preview'}
        data-expanded={expanded ? '' : undefined}
      >
        {source.kind === 'ready' ? (
          body.trim() === '' ? (
            <p className="text-text-muted">Empty note</p>
          ) : expanded ? (
            <NoteEmbedBody
              source={source.source}
              sourcePath={source.path}
              headingOffset={ancestors.length}
              generation={generation}
              remoteEmbeds={remoteEmbeds}
              renderNoteEmbed={renderNested}
              onWikiLinkClick={navigation.onWikiLinkClick}
              onLinkClick={navigation.onLinkClick}
            />
          ) : (
            <MarkdownPreview
              content={preview}
              headingOffset={ancestors.length}
              resolveWikiEmbed={previewAttachments.resolveWikiEmbed}
              interactive={false}
              remoteEmbeds={false}
              className="reflect-note-surface"
            />
          )
        ) : source.kind === 'loading' ? (
          <p role="status" className="text-sm text-text-muted">
            {label} <span className="text-xs">Loading preview…</span>
          </p>
        ) : (
          <div className="text-sm text-text-muted">
            <p>{label}</p>
            <p className="text-xs">
              {FAILURE_LABELS[source.kind]}{' '}
              {source.kind !== 'cycle' && source.kind !== 'limit' ? (
                <button type="button" onClick={reload} className="underline underline-offset-2">
                  Try again
                </button>
              ) : null}
            </p>
          </div>
        )}
      </div>
      <div
        className={cn(
          'flex items-center justify-end gap-2',
          !expanded && source.kind === 'ready' && 'pointer-events-none',
        )}
      >
        <button
          type="button"
          title={expanded ? `Collapse ${label}` : `Read full ${label}`}
          aria-label={label}
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={() => {
            revealed.current = false
            setExpanded(!expanded)
          }}
          className={cn(
            'pointer-events-auto cursor-pointer rounded-sm text-xs text-text-muted hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus-ring',
            !expanded && source.kind === 'ready'
              ? 'absolute inset-0 border-0 bg-transparent'
              : 'min-h-11 px-1 sm:pointer-fine:min-h-8',
          )}
        >
          <span
            aria-hidden
            className={cn(
              'inline-flex items-center gap-1',
              !expanded &&
                source.kind === 'ready' &&
                'absolute right-11 bottom-0 h-11 sm:pointer-fine:h-8',
            )}
          >
            {expanded ? 'Collapse' : 'Read full note'}
            {expanded ? (
              <ChevronUp aria-hidden className="size-3" />
            ) : (
              <ChevronDown aria-hidden className="size-3" />
            )}
          </span>
        </button>
        <button
          type="button"
          title="Open original note"
          aria-label={`Open ${label}`}
          onClick={(event) => {
            const fragment = splitWikiLinkTarget(target).fragment
            const destination =
              source.kind === 'ready'
                ? `/${source.path}${fragment === null ? '' : `#${fragment}`}`
                : target
            navigation.open(destination, event.metaKey || event.ctrlKey)
          }}
          className={cn(
            'pointer-events-auto relative flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-sm text-text-muted transition-opacity duration-150 group-hover/note-embed:opacity-100 group-focus-within/note-embed:opacity-100 hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus-ring motion-reduce:transition-none pointer-fine:opacity-0 sm:pointer-fine:min-h-8 sm:pointer-fine:min-w-8',
            !expanded && source.kind === 'ready' && 'self-end',
          )}
        >
          <ArrowUpRight aria-hidden className="size-3.5" />
        </button>
      </div>
    </div>
  )
}

/** Stable host renderer for one source note and graph session. */
export function useNoteEmbedRenderer(
  options: Omit<NoteEmbedReaderOptions, 'ancestors'>,
): NoteEmbedRenderer {
  const { sourcePath, generation, graphKey, remoteEmbeds } = options
  const ancestors = useMemo(() => [sourcePath], [sourcePath])
  return useCallback(
    (payload) => (
      <NoteEmbedReader
        key={`${graphKey}:${generation}:${payload.target}`}
        {...payload}
        sourcePath={sourcePath}
        generation={generation}
        graphKey={graphKey}
        ancestors={ancestors}
        remoteEmbeds={remoteEmbeds}
      />
    ),
    [sourcePath, generation, graphKey, ancestors, remoteEmbeds],
  )
}
