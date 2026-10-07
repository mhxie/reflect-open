import { normalizeReferenceLabel, parseReferenceDefinition } from '@meowdown/markdown'
import { splitFrontmatter } from '../markdown/frontmatter.ts'
import { parseBody } from '../markdown/grammar.ts'
import { parseInlineLink } from '../markdown/link-syntax.ts'
import { unescapeMarkdownText } from '../markdown/plain-text.ts'
import { isWikiCitationTarget, readWikiCitationComment, type WikiCitationDates } from './anchors.ts'
import {
  readWikiClaimIndex,
  wikiSourceSpan,
  type WikiClaimIndex,
  type WikiSourceSpan,
} from './article.ts'

/** An occurrence retains its locator and dates even when another occurrence shares its number. */
export interface WikiReferenceOccurrence extends WikiSourceSpan {
  readonly key: string
  readonly number: number
  readonly kind: 'external' | 'note'
  readonly target: string
  readonly label: string
  readonly locator: string | null
  readonly claimId: string | null
  readonly dates: WikiCitationDates | null
  readonly current: boolean
  readonly compact: boolean
}

/** Adjacent occurrences sorted for display; source order and source bytes are untouched. */
export interface WikiReferenceGroup extends WikiSourceSpan {
  readonly occurrences: readonly WikiReferenceOccurrence[]
}

/** A bibliography entry shares a number, never the mutable metadata of one occurrence. */
export interface WikiBibliographyEntry {
  readonly key: string
  readonly number: number
  readonly kind: 'external' | 'note'
  readonly target: string
  readonly label: string
  readonly occurrences: readonly WikiReferenceOccurrence[]
}

/** Shared note-level projection for editor, preview, exact navigation, and summaries. */
export interface WikiArticleIndex extends WikiClaimIndex {
  readonly references: readonly WikiReferenceOccurrence[]
  readonly groups: readonly WikiReferenceGroup[]
  readonly bibliography: readonly WikiBibliographyEntry[]
  readonly definitions: readonly WikiSourceSpan[]
}

/** Optional resolved note identities let aliases share one bibliography source. */
export interface WikiArticleOptions {
  readonly noteIdentity?: (title: string) => string | null
}

function noteKey(target: string, options: WikiArticleOptions): string {
  const hash = target.indexOf('#')
  const title = hash === -1 ? target : target.slice(0, hash)
  const fragment = hash === -1 ? '' : target.slice(hash).toLowerCase()
  return `note:${options.noteIdentity?.(title) ?? title.normalize('NFKC').trim().toLowerCase()}${fragment}`
}

/** Number explicit source references independently of evidence and review status. */
export function readWikiArticle(
  source: string,
  asOf: string,
  options: WikiArticleOptions = {},
): WikiArticleIndex {
  const claims = readWikiClaimIndex(source, asOf)
  const { body, bodyOffset } = splitFrontmatter(source)
  const tree = parseBody(body)
  const definitions = new Map<string, { href: string; title: string }>()
  const definitionSpans: WikiSourceSpan[] = []
  tree.iterate({
    enter: (cursor) => {
      if (cursor.name === 'FencedCode' || cursor.name === 'CodeBlock') return false
      if (cursor.name !== 'LinkReference') return
      const definition = parseReferenceDefinition(body.slice(cursor.from, cursor.to))
      if (definition !== undefined) {
        if (!definitions.has(definition.key)) definitions.set(definition.key, definition)
        definitionSpans.push(
          wikiSourceSpan(source, cursor.from + bodyOffset, cursor.to + bodyOffset),
        )
      }
      return false
    },
  })
  const occurrences: Omit<WikiReferenceOccurrence, 'number'>[] = []
  const diagnostics = [...claims.diagnostics]
  tree.iterate({
    enter: (cursor) => {
      if (
        /^(?:FencedCode|CodeBlock|InlineCode|Comment|CommentBlock|LinkReference|Image|WikiEmbed)$/.test(
          cursor.name,
        )
      )
        return false
      if (cursor.name !== 'Link' && cursor.name !== 'Wikilink') return
      const from = cursor.from + bodyOffset
      let to = cursor.to + bodyOffset
      const raw = source.slice(from, to)
      let kind: WikiReferenceOccurrence['kind'] = 'external'
      let target = ''
      let label = ''
      let locator: string | null = null
      let dates: WikiCitationDates | null = null
      let metadataValid = true
      if (cursor.name === 'Wikilink') {
        const inner = raw.slice(2, -2)
        const pipe = inner.indexOf('|')
        if (pipe === -1 || inner.slice(pipe + 1).trim() !== 'ref') return false
        target = unescapeMarkdownText(inner.slice(0, pipe).trim())
        if (!isWikiCitationTarget(target)) return false
        kind = 'note'
        label = target
        const next = cursor.node.nextSibling
        if (next?.name === 'Comment' && next.from === cursor.to) {
          const comment = body.slice(next.from, next.to)
          if (/^<!--\s*\{/.test(comment)) {
            dates = readWikiCitationComment(comment)
            metadataValid = dates !== null
            to = next.to + bodyOffset
            if (!metadataValid)
              diagnostics.push({
                ...wikiSourceSpan(source, from, to),
                claimId: null,
                message: 'Citation metadata is malformed; the original citation remains visible.',
              })
          }
        }
      } else {
        const referenceLabel = cursor.node.getChild('LinkLabel')
        const linkMarks = cursor.node.getChildren('LinkMark')
        const textStart = linkMarks[0]?.to
        const textEnd = linkMarks[1]?.from
        if (
          textStart === undefined ||
          textEnd === undefined ||
          body.slice(textStart, textEnd) !== 'ref'
        )
          return false
        if (referenceLabel !== null) {
          const key = normalizeReferenceLabel(
            body.slice(referenceLabel.from + 1, referenceLabel.to - 1) || 'ref',
          )
          const definition = definitions.get(key)
          if (definition === undefined) return false
          target = definition.href
          locator = definition.title || null
        } else {
          const inline = parseInlineLink(raw)
          if (inline === null) return false
          target = inline.href
          const title = cursor.node.getChild('LinkTitle')
          locator =
            title === null ? null : unescapeMarkdownText(body.slice(title.from + 1, title.to - 1))
        }
        if (!/^https?:\/\//i.test(target)) return false
        label = locator ?? target
      }
      const owner = claims.claims.find((claim) => from >= claim.from && to <= claim.to)
      const crossing = claims.claims.find(
        (claim) => from < claim.to && to > claim.from && claim !== owner,
      )
      if (crossing !== undefined)
        diagnostics.push({
          ...wikiSourceSpan(source, from, to),
          claimId: crossing.id,
          message: `${crossing.id} splits a citation or its date metadata.`,
        })
      const current =
        dates === null ||
        (dates.validAt <= asOf && (dates.invalidAt === undefined || dates.invalidAt > asOf))
      occurrences.push({
        ...wikiSourceSpan(source, from, to),
        key: kind === 'note' ? noteKey(target, options) : `url:${target}`,
        kind,
        target,
        label,
        locator,
        dates,
        current,
        claimId: owner?.id ?? null,
        compact: metadataValid && crossing === undefined,
      })
      return false
    },
  })
  const numbers = new Map<string, number>()
  const references = occurrences.map((occurrence): WikiReferenceOccurrence => {
    let number = numbers.get(occurrence.key)
    if (number === undefined) {
      number = numbers.size + 1
      numbers.set(occurrence.key, number)
    }
    return { ...occurrence, number }
  })
  const groups: WikiReferenceGroup[] = []
  for (const occurrence of references) {
    if (!occurrence.compact) continue
    const previous = groups.at(-1)
    if (previous !== undefined && /^[ \t]*$/.test(source.slice(previous.to, occurrence.from))) {
      groups[groups.length - 1] = {
        ...wikiSourceSpan(source, previous.from, occurrence.to),
        occurrences: [...previous.occurrences, occurrence].sort(
          (left, right) => left.number - right.number,
        ),
      }
    } else
      groups.push({
        ...wikiSourceSpan(source, occurrence.from, occurrence.to),
        occurrences: [occurrence],
      })
  }
  const bibliography = [...numbers].map(([key, number]): WikiBibliographyEntry => {
    const own = references.filter((reference) => reference.key === key)
    const first = own[0]!
    return {
      key,
      number,
      kind: first.kind,
      target: first.target,
      label: first.label,
      occurrences: own,
    }
  })
  return { ...claims, diagnostics, references, groups, bibliography, definitions: definitionSpans }
}
