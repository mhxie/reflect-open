import type { ReactElement } from 'react'
import { MarkdownView } from '@meowdown/react'
import type { WikiEvidenceOptions } from './wiki-evidence.ts'

interface WikiArticleRevisionProps {
  readonly markdown: string
  readonly options: WikiEvidenceOptions
}

/** Revision records are a source-backed disclosure, outside the reading paragraphs. */
export function WikiArticleRevision({ markdown, options }: WikiArticleRevisionProps): ReactElement {
  if (!options.interactive) return <span className="text-text-muted">Revision Log</span>
  return (
    <details className="wiki-article-revision" contentEditable={false}>
      <summary>Revision Log</summary>
      <MarkdownView markdown={markdown} markMode="hide" interactive={false} remoteMedia={false} />
      {options.edit === undefined ? null : (
        <button
          type="button"
          onClick={options.edit}
          className="text-xs text-text-muted hover:underline"
        >
          Edit source
        </button>
      )}
    </details>
  )
}
