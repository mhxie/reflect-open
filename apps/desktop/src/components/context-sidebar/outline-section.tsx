import type { ReactElement } from 'react'
import { outlineDepths } from '@/editor/outline/outline-headings.ts'
import { useNoteOutline } from '@/editor/outline/outline-store.ts'
import { cn } from '@/lib/utils.ts'
import { SidebarSection } from './sidebar-section.tsx'

interface OutlineSectionProps {
  /** Graph-relative path of the open note whose headings to list. */
  path: string
}

/** Left padding per indent depth; index = depth. */
const DEPTH_PADDING = ['pl-3', 'pl-6', 'pl-9', 'pl-12'] as const

/**
 * The open note's section headings, indented by level, with the section being
 * read highlighted; a row jumps to its heading. Renders nothing until the
 * editor publishes an outline with section headings.
 */
export function OutlineSection({ path }: OutlineSectionProps): ReactElement | null {
  const outline = useNoteOutline(path)
  if (outline === null || outline.headings.length === 0) {
    return null
  }
  const depths = outlineDepths(outline.headings)

  return (
    <SidebarSection storageKey="outline" title="Outline">
      <ul className="space-y-0.5">
        {outline.headings.map((heading, index) => {
          const active = index === outline.activeIndex
          return (
            <li key={heading.position}>
              <button
                type="button"
                aria-current={active ? 'location' : undefined}
                onClick={() => outline.reveal(index)}
                className={cn(
                  'flex w-full rounded-md py-1 pr-3 leading-5 hover:bg-surface-hover hover:text-text',
                  DEPTH_PADDING[depths[index] ?? 0],
                  active
                    ? 'bg-surface-hover text-text dark:bg-transparent dark:text-accent'
                    : 'text-text-secondary',
                )}
              >
                <span className="min-w-0 flex-1 truncate text-left text-xs font-medium">
                  {heading.text}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </SidebarSection>
  )
}
