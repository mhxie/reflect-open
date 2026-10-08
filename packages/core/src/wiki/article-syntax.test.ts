import { describe, expect, it } from 'vitest'
import {
  isWikiBibliographyHeading,
  isWikiRevisionHeading,
  wikiLedgerOwner,
  wikiPendingPass,
} from './article-syntax.ts'

describe('wiki article syntax', () => {
  it('reads the claim an anchors fence belongs to', () => {
    expect(wikiLedgerOwner('anchors c12')).toBe('c12')
    expect(wikiLedgerOwner('anchors c0')).toBeNull()
    expect(wikiLedgerOwner('anchors')).toBeNull()
    expect(wikiLedgerOwner('ts')).toBeNull()
  })

  it('recognizes the administrative headings however they are cased or padded', () => {
    expect(isWikiBibliographyHeading('Evidence')).toBe(true)
    expect(isWikiBibliographyHeading(' references ')).toBe(true)
    expect(isWikiBibliographyHeading('Evidence notes')).toBe(false)
    expect(isWikiRevisionHeading('Revision Log')).toBe(true)
    expect(isWikiRevisionHeading('revision log ')).toBe(true)
    expect(isWikiRevisionHeading('Revisions')).toBe(false)
  })

  it('formats a pending editor pass', () => {
    expect(wikiPendingPass('2026-10-07')).toBe('@pass: editor | status: pending | at: 2026-10-07')
  })
})
