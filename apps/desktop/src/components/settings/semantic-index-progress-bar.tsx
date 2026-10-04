import type { ReactElement } from 'react'
import { Progress } from '@/components/ui/progress.tsx'
import type { SemanticIndexProgress } from '@/lib/semantic-index-progress.ts'

interface SemanticIndexProgressBarProps {
  /** The running backfill's position. */
  progress: SemanticIndexProgress
}

const COUNT = new Intl.NumberFormat('en-US')

/** The embedding backfill: notes walked so far out of the graph's total. */
export function SemanticIndexProgressBar({
  progress,
}: SemanticIndexProgressBarProps): ReactElement {
  const percent = progress.total > 0 ? Math.min((progress.done / progress.total) * 100, 100) : 0

  return (
    <div className="mt-3">
      <Progress value={Math.round(percent)} aria-label="Semantic index" />
      <p className="mt-1.5 text-xs text-text-muted">
        Updating the semantic index: {COUNT.format(progress.done)} of {COUNT.format(progress.total)}{' '}
        notes
      </p>
    </div>
  )
}
