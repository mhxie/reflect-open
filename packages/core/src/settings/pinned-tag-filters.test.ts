import { describe, expect, it } from 'vitest'
import { settingsSchema } from './schema.ts'
import {
  movePinnedFilterTag,
  normalizePinnedTag,
  normalizePinnedTags,
  orderPinnedFilterTags,
  pinFilterTag,
  reorderPinnedFilterTags,
  unpinFilterTag,
} from './pinned-tag-filters.ts'

describe('pinned tag filters', () => {
  it('uses the indexed tag grammar and retains canonical first-occurrence order', () => {
    expect(normalizePinnedTag('  ##Research ')).toBe('research')
    expect(normalizePinnedTag('#读书/项目_二-3')).toBe('读书/项目_二-3')
    expect(normalizePinnedTag('two words')).toBeNull()
    expect(normalizePinnedTag(123)).toBeNull()
    expect(normalizePinnedTags(['#BOOK', ' link ', 'book', '', 'bad tag', '读书'])).toEqual([
      'book',
      'link',
      '读书',
    ])
    expect(normalizePinnedTags({ tags: ['book'] })).toEqual([])
  })

  it('supports valid zero-result pins, duplicate no-ops, and an intentional empty list', () => {
    expect(pinFilterTag(['book'], '#Research')).toEqual(['book', 'research'])
    expect(pinFilterTag(['book'], '#BOOK')).toEqual(['book'])
    expect(pinFilterTag(['book'], 'invalid tag')).toEqual(['book'])
    expect(unpinFilterTag(['book'], 'BOOK')).toEqual([])
    expect(settingsSchema.parse({ allNotesFilterTags: [] }).allNotesFilterTags).toEqual([])
  })

  it('moves filters to menu positions without losing any pins', () => {
    const tags = ['book', 'link', 'person', 'research']
    expect(movePinnedFilterTag(tags, 'person', 'top')).toEqual([
      'person',
      'book',
      'link',
      'research',
    ])
    expect(movePinnedFilterTag(tags, 'link', 'up')).toEqual(['link', 'book', 'person', 'research'])
    expect(movePinnedFilterTag(tags, 'link', 'down')).toEqual([
      'book',
      'person',
      'link',
      'research',
    ])
    expect(movePinnedFilterTag(tags, 'book', 'bottom')).toEqual([
      'link',
      'person',
      'research',
      'book',
    ])
    expect(movePinnedFilterTag(tags, 'book', 'up')).toEqual(tags)
    expect(movePinnedFilterTag(tags, 'research', 'down')).toEqual(tags)
    expect(movePinnedFilterTag(tags, 'missing', 'top')).toEqual(tags)
    expect(tags).toEqual(['book', 'link', 'person', 'research'])
  })

  it('commits complete permutations and rejects stale or incomplete drag snapshots', () => {
    const original = ['book', 'link', 'person']
    const next = orderPinnedFilterTags(original, 'book', 'person')
    expect(next).toEqual(['link', 'person', 'book'])
    expect(reorderPinnedFilterTags(original, original, next)).toEqual(next)
    expect(reorderPinnedFilterTags([...original, 'research'], original, next)).toEqual([
      ...original,
      'research',
    ])
    expect(reorderPinnedFilterTags(['book', 'person'], original, next)).toEqual(['book', 'person'])
    expect(reorderPinnedFilterTags(original, original, ['person', 'book'])).toEqual(original)
    expect(reorderPinnedFilterTags(original, original, ['book', 'book', 'person'])).toEqual(
      original,
    )
    expect(reorderPinnedFilterTags(original, original, ['book', 'person', 'unknown'])).toEqual(
      original,
    )
    expect(reorderPinnedFilterTags(original, original, ['book', 'person', 'bad tag'])).toEqual(
      original,
    )
    expect(orderPinnedFilterTags(original, 'missing', 'person')).toEqual(original)
  })
})
