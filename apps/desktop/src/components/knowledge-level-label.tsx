import type { ReactElement } from 'react'
import { useKnowledgeLevel } from '@/hooks/use-knowledge-level.ts'
import { cn } from '@/lib/utils.ts'

interface KnowledgeLevelLabelProps {
  readonly path: string
  readonly className?: string
  readonly compact?: boolean
}

/** The knowledge layer is a path classification, separate from evidence/reviewer status. */
export function KnowledgeLevelLabel({
  path,
  className,
  compact = false,
}: KnowledgeLevelLabelProps): ReactElement | null {
  const state = useKnowledgeLevel(path)
  if (state.kind === 'unclassified') return null
  if (state.kind === 'unavailable') {
    return (
      <span
        className={cn('shrink-0 text-[11px] text-text-muted', className)}
        title="Knowledge level rules are unavailable or invalid."
        aria-label="Knowledge level unavailable"
      >
        L?
      </span>
    )
  }
  const { level, label, role } = state.classification
  const description =
    role === 'shadow'
      ? 'Translation of a source entry. This knowledge layer does not establish independent validation.'
      : 'Knowledge layer. Evidence and review status are recorded separately.'
  return (
    <span
      className={cn('shrink-0 whitespace-nowrap text-[11px] text-text-muted', className)}
      title={compact ? `L${level} · ${label}. ${description}` : description}
      data-knowledge-level={level}
    >
      L{level}
      {compact ? '' : ` · ${label}`}
      {!compact && role === 'shadow' ? ' · Translation' : ''}
    </span>
  )
}
