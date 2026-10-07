import type { ReactElement } from 'react'
import type { WikiArticleIndex } from '@reflect/core'
import type { WikiEvidenceOptions } from './wiki-evidence.ts'

interface WikiArticleBibliographyProps {
  readonly index: WikiArticleIndex
  readonly options: WikiEvidenceOptions
}

/** Document numbering deduplicates targets while every distinct locator remains listed. */
export function WikiArticleBibliography({
  index,
  options,
}: WikiArticleBibliographyProps): ReactElement | null {
  if (index.bibliography.length === 0) return null
  return (
    <div className="wiki-article-bibliography" contentEditable={false} aria-label="References">
      <ol>
        {index.bibliography.map((reference) => (
          <li key={reference.key} value={reference.number}>
            {options.interactive ? (
              <button
                type="button"
                className="text-left text-text-secondary underline-offset-2 hover:underline"
                onClick={(event) =>
                  reference.kind === 'note'
                    ? options.openWikiLink?.({
                        target: reference.target,
                        openInNewWindow: event.metaKey || event.ctrlKey,
                      })
                    : options.openUrl?.(reference.target, event.nativeEvent)
                }
              >
                {reference.kind === 'note'
                  ? reference.target
                  : reference.target.replace(/^https?:\/\//, '')}
              </button>
            ) : (
              <span>{reference.target}</span>
            )}
            {[
              ...new Set(
                reference.occurrences
                  .map((occurrence) => occurrence.locator)
                  .filter((locator) => locator !== null),
              ),
            ].map((locator) => (
              <span key={locator} className="block text-text-muted">
                {locator}
              </span>
            ))}
          </li>
        ))}
      </ol>
    </div>
  )
}
