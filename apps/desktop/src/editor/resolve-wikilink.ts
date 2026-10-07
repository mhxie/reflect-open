import type { WikilinkPayload, WikilinkResolution } from '@meowdown/core'
import {
  displayNoteTitle,
  isWikiCitationTarget,
  readWikiCitationMetadata,
  splitWikiLinkTarget,
  wikiCitationDescription,
} from '@reflect/core'
import { todayIso } from '@/lib/dates.ts'

/**
 * The wiki-link chip rule shared by every meowdown surface: `[[target|alias]]`
 * splits at its first `|` (both halves trimmed) into the target the click and
 * hover handlers receive and the label the chip shows, and a target without an
 * alias (or with a blank one) reads as its display title, so `[[A // B]]` shows
 * its first segment. Pure: meowdown caches the result per parse.
 */
export function resolveWikilink({
  target,
  metadata,
}: WikilinkPayload): WikilinkResolution | undefined {
  const pipe = target.indexOf('|')
  const canonical = (pipe === -1 ? target : target.slice(0, pipe)).trim()
  const alias = pipe === -1 ? '' : target.slice(pipe + 1).trim()
  const citation =
    alias === 'ref' && isWikiCitationTarget(canonical) ? readWikiCitationMetadata(metadata) : null
  if (citation !== null && citation.validAt <= todayIso()) {
    const { name, fragment } = splitWikiLinkTarget(canonical)
    return {
      target: canonical,
      display: `${displayNoteTitle(name)}${fragment === null ? '' : `#${fragment}`}`,
      appearance: 'reference',
      description: wikiCitationDescription(citation),
    }
  }
  const display = alias === '' ? displayNoteTitle(canonical) : alias
  if (pipe === -1 && display === canonical) {
    return undefined
  }
  return { target: canonical, display }
}
