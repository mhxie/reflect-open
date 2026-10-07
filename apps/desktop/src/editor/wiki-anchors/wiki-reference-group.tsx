import type { ReactElement } from 'react'
import type { WikiArticleIndex, WikiReferenceGroup, WikiReferenceOccurrence } from '@reflect/core'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.tsx'
import type { WikiEvidenceOptions } from './wiki-evidence.ts'

interface WikiReferenceGroupProps {
  readonly group: WikiReferenceGroup
  readonly index: WikiArticleIndex
  readonly options: WikiEvidenceOptions
}

function description(reference: WikiReferenceOccurrence): string {
  const dates = reference.dates
  return [
    reference.label,
    reference.locator,
    dates === null
      ? null
      : `Recorded ${dates.validAt}${dates.invalidAt === undefined ? '' : `; invalidated ${dates.invalidAt}`}`,
    reference.current ? null : 'Historical evidence',
  ]
    .filter(Boolean)
    .join(' · ')
}

/** Every trigger owns its occurrence's locator and date metadata. */
export function WikiReferenceGroupView({
  group,
  index,
  options,
}: WikiReferenceGroupProps): ReactElement {
  return (
    <span className="wiki-article-references" contentEditable={false} data-wiki-reference-group="">
      {group.occurrences.map((reference) =>
        options.interactive ? (
          <Popover key={reference.from}>
            <PopoverTrigger
              render={
                <button
                  type="button"
                  className="wiki-article-reference"
                  aria-label={`Reference ${reference.number}: ${description(reference)}`}
                >
                  [{reference.number}]
                </button>
              }
            />
            <PopoverContent
              side="top"
              align="start"
              className="w-80 max-w-[calc(100vw-2rem)] text-xs"
            >
              <div className="space-y-2">
                <p className="font-medium text-text">{reference.label}</p>
                {reference.locator !== null && reference.locator !== reference.label ? (
                  <p>{reference.locator}</p>
                ) : null}
                {reference.dates !== null ? (
                  <p className="text-text-muted">
                    Recorded {reference.dates.validAt}
                    {reference.dates.invalidAt === undefined
                      ? ''
                      : `; invalidated ${reference.dates.invalidAt}`}
                  </p>
                ) : null}
                {!reference.current ? <p className="text-text-muted">Historical evidence</p> : null}
                <button
                  type="button"
                  className="text-accent underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-accent"
                  onClick={(event) => {
                    if (reference.kind === 'note')
                      options.openWikiLink?.({
                        target: reference.target,
                        openInNewWindow: event.metaKey || event.ctrlKey,
                        ...(event.altKey ? { peek: true } : {}),
                      })
                    else options.openUrl?.(reference.target, event.nativeEvent)
                  }}
                >
                  Open source
                </button>
                {options.edit === undefined ? null : (
                  <button
                    type="button"
                    className="ml-3 text-text-muted underline-offset-2 hover:underline"
                    onClick={options.edit}
                  >
                    Edit citation
                  </button>
                )}
                {reference.claimId === null ? null : (
                  <details>
                    <summary className="cursor-pointer text-text-muted">Evidence history</summary>
                    <pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap break-words text-2xs">
                      {index.ledgers
                        .filter((ledger) => ledger.owner === reference.claimId)
                        .map((ledger) => ledger.raw)
                        .join('\n\n') || 'No evidence records.'}
                    </pre>
                  </details>
                )}
              </div>
            </PopoverContent>
          </Popover>
        ) : (
          <span
            key={reference.from}
            className="wiki-article-reference"
            title={description(reference)}
            aria-label={`Reference ${reference.number}: ${description(reference)}`}
          >
            [{reference.number}]
          </span>
        ),
      )}
    </span>
  )
}
