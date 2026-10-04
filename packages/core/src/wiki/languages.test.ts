import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WIKI_LANGUAGES,
  isWikiPath,
  normalizeWikiFolder,
  normalizeWikiLanguages,
  wikiLocation,
  wikiPathIn,
  wikiSourceLanguage,
  wikiTopic,
} from './languages.ts'

describe('normalizeWikiFolder', () => {
  it('trims a folder and drops its outer slashes, keeping nested folders', () => {
    expect(normalizeWikiFolder('  /wiki-ja/ ')).toBe('wiki-ja')
    expect(normalizeWikiFolder('knowledge/wiki')).toBe('knowledge/wiki')
  })

  it('refuses spellings that cannot name a plain graph folder', () => {
    for (const input of [
      '',
      '/',
      'a//b',
      '.',
      '..',
      'wiki/../x',
      '.reflect',
      String.raw`a\b`,
      'tab\tname',
    ]) {
      expect(normalizeWikiFolder(input)).toBeNull()
    }
  })
})

describe('normalizeWikiLanguages', () => {
  it('keeps valid entries in order, trimmed', () => {
    expect(
      normalizeWikiLanguages([
        { label: ' English ', folder: 'wiki/' },
        { label: '日本語', folder: 'wiki-ja' },
      ]),
    ).toEqual([
      { label: 'English', folder: 'wiki' },
      { label: '日本語', folder: 'wiki-ja' },
    ])
  })

  it('drops entries without a label or a valid folder, and folders overlapping an earlier one', () => {
    expect(
      normalizeWikiLanguages([
        { label: 'English', folder: 'wiki' },
        { label: '', folder: 'wiki-fr' },
        { label: 'Deutsch', folder: '..' },
        { label: 'Again', folder: 'wiki' },
        { label: 'Nested', folder: 'wiki/zh' },
        'not an entry',
        null,
        { label: '简体中文', folder: 'wiki-cn' },
      ]),
    ).toEqual([
      { label: 'English', folder: 'wiki' },
      { label: '简体中文', folder: 'wiki-cn' },
    ])
  })

  it('falls back to the defaults when nothing usable remains', () => {
    expect(normalizeWikiLanguages([])).toEqual(DEFAULT_WIKI_LANGUAGES)
    expect(normalizeWikiLanguages([{ label: 'x', folder: '' }])).toEqual(DEFAULT_WIKI_LANGUAGES)
  })
})

describe('wikiLocation', () => {
  const languages = DEFAULT_WIKI_LANGUAGES

  it('names the language folder a note lies in and its path there', () => {
    expect(wikiLocation('wiki-cn/memory/Spacing Effect.md', languages)).toEqual({
      language: { label: '简体中文', folder: 'wiki-cn' },
      relativePath: 'memory/Spacing Effect.md',
    })
    expect(wikiLocation('wiki/index.md', languages)?.language).toBe(wikiSourceLanguage(languages))
  })

  it('is null outside the wiki, including folders that only share a prefix', () => {
    expect(wikiLocation('notes/wiki.md', languages)).toBeNull()
    expect(wikiLocation('wikipedia/page.md', languages)).toBeNull()
    expect(wikiLocation('wiki', languages)).toBeNull()
    expect(isWikiPath('wiki-cn/a.md', languages)).toBe(true)
    expect(isWikiPath('notes/a.md', languages)).toBe(false)
  })
})

describe('wikiPathIn / wikiTopic', () => {
  it('maps a relative path into a language and reads its topic folder', () => {
    expect(wikiPathIn({ label: '简体中文', folder: 'wiki-cn' }, 'memory/A.md')).toBe(
      'wiki-cn/memory/A.md',
    )
    expect(wikiTopic('memory/A.md')).toBe('memory')
    expect(wikiTopic('index.md')).toBeNull()
  })
})
