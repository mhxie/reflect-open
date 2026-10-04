import type { ReactElement } from 'react'
import { BookOpen, Link, ListOrdered } from 'lucide-react'
import { isWikiGuide, type WikiEntry } from '@reflect/core'
import { WikiCount } from './wiki-count.tsx'
import { WikiReviewGlyph } from './wiki-review-glyph.tsx'

/**
 * The Wiki screen's own columns (Review · Claims · Sources · Cited by), packed
 * tighter than the table's — the header row uses the same classes so the
 * columns line up.
 */
export const WIKI_SIGNALS_GRID = 'grid grid-cols-[2rem_2.5rem_2.25rem_2.25rem] items-center gap-x-1'

interface WikiSignalsProps {
  entry: WikiEntry
}

function counted(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

/**
 * An entry's wiki columns: reviewer standing, its claims (with an amber dot
 * when one lacks a source), distinct sources, and the notes citing it. Guides
 * make no claims and an unread entry has no summary, so theirs stay blank.
 */
export function WikiSignals({ entry }: WikiSignalsProps): ReactElement {
  const summary = entry.summary !== null && !isWikiGuide(entry) ? entry.summary : null
  return (
    <div className={WIKI_SIGNALS_GRID}>
      <span>{summary === null ? null : <WikiReviewGlyph summary={summary} />}</span>
      <span>
        {summary === null ? null : (
          <WikiCount
            icon={ListOrdered}
            count={summary.claims}
            label={
              summary.unsourcedClaims > 0
                ? `${counted(summary.claims, 'claim')}, ${summary.unsourcedClaims} without a source`
                : counted(summary.claims, 'claim')
            }
          >
            {summary.unsourcedClaims > 0 ? (
              <span aria-hidden className="size-1.5 flex-none rounded-full bg-amber-500" />
            ) : null}
          </WikiCount>
        )}
      </span>
      <span>
        {summary === null || summary.sources === 0 ? null : (
          <WikiCount
            icon={BookOpen}
            count={summary.sources}
            label={counted(summary.sources, 'source')}
          />
        )}
      </span>
      <span>
        {entry.citedBy === 0 ? null : (
          <WikiCount
            icon={Link}
            count={entry.citedBy}
            label={`Cited by ${counted(entry.citedBy, 'note')}`}
          />
        )}
      </span>
    </div>
  )
}
