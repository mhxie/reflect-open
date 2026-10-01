import { describe, expect, it } from 'vitest'
import {
  buildFtsAnyMatch,
  buildFtsMatch,
  containsUnsegmentedScript,
  isSentenceLike,
  titleRecallNeedles,
} from './search-query.ts'

describe('buildFtsMatch', () => {
  it('returns null for an empty or whitespace-only query', () => {
    expect(buildFtsMatch('')).toBeNull()
    expect(buildFtsMatch('   \t \n ')).toBeNull()
  })

  it('prefix-matches title and body tokens', () => {
    expect(buildFtsMatch('hello')).toBe('(title : "hello"* OR body : "hello"* OR cjk : "hello"*)')
  })

  it('quotes each term before adding controlled FTS5 operators', () => {
    expect(buildFtsMatch('cats AND (dogs*)')).toBe(
      '(title : "cats"* OR body : "cats"* OR cjk : "cats"*) AND (title : "AND"* OR body : "AND"* OR cjk : "AND"*) AND (title : "(dogs*)"* OR body : "(dogs*)"* OR cjk : "(dogs*)"*)',
    )
  })

  it('doubles embedded double-quotes (FTS5 escaping)', () => {
    expect(buildFtsMatch('say "hi"')).toBe(
      '(title : "say"* OR body : "say"* OR cjk : "say"*) AND (title : """hi"""* OR body : """hi"""* OR cjk : """hi"""*)',
    )
  })

  it('collapses runs of whitespace between terms', () => {
    expect(buildFtsMatch('  alpha   beta ')).toBe(
      '(title : "alpha"* OR body : "alpha"* OR cjk : "alpha"*) AND (title : "beta"* OR body : "beta"* OR cjk : "beta"*)',
    )
  })

  it('drops a term that tokenizes to nothing rather than emptying the query', () => {
    expect(buildFtsMatch('meeting - notes')).toBe(
      '(title : "meeting"* OR body : "meeting"* OR cjk : "meeting"*) AND (title : "notes"* OR body : "notes"* OR cjk : "notes"*)',
    )
    expect(buildFtsMatch('c++ +')).toBe('(title : "c++"* OR body : "c++"* OR cjk : "c++"*)')
  })

  it('keeps unsegmented-script terms, whose characters are Unicode letters', () => {
    expect(buildFtsMatch('東京 ・')).toBe('(title : "東京"* OR body : "東京"* OR cjk : "東京")')
    expect(buildFtsMatch('中文')).toBe('(title : "中文"* OR body : "中文"* OR cjk : "中文")')
  })

  it('matches an unsegmented run anywhere through its character pairs', () => {
    // `unicode61` indexes the clause 我们下周去東京旅行 as one token, so only
    // the `cjk` pairs can find 東京旅行 inside it.
    expect(buildFtsMatch('東京旅行')).toBe(
      '(title : "東京旅行"* OR body : "東京旅行"* OR cjk : "東京 京旅 旅行")',
    )
    // A lone character matches any token it starts; mixed scripts constrain
    // every run and every letter stretch, the latter glued or spaced.
    expect(buildFtsMatch('我')).toBe('(title : "我"* OR body : "我"* OR cjk : "我"*)')
    expect(buildFtsMatch('用Python写脚本')).toBe(
      '(title : "用Python写脚本"* OR body : "用Python写脚本"* OR (cjk : "用"* AND cjk : "写脚 脚本" AND (cjk : "Python"* OR title : "Python"* OR body : "Python"*)))',
    )
  })

  it('also looks for a word in the cjk column, where it lands when glued to a run', () => {
    expect(buildFtsMatch('Python')).toBe(
      '(title : "Python"* OR body : "Python"* OR cjk : "Python"*)',
    )
  })

  it('falls back to the quoted join when no term tokenizes', () => {
    expect(buildFtsMatch('-')).toBe('"-"')
    expect(buildFtsMatch('. -')).toBe('"." "-"')
  })

  it('classifies terms by the tokenizer categories, not by `is alphabetic`', () => {
    // Private use is a token character (`L* N* Co`), so the term constrains.
    expect(buildFtsMatch('\u{F8FF}')).toBe(
      '(title : "\u{F8FF}"* OR body : "\u{F8FF}"* OR cjk : "\u{F8FF}"*)',
    )
    // A combining mark and an enclosed alphanumeric are separators, even
    // though both carry the Unicode `Alphabetic` property.
    expect(buildFtsMatch('hello \u{345}')).toBe(
      '(title : "hello"* OR body : "hello"* OR cjk : "hello"*)',
    )
    expect(buildFtsMatch('hello \u{24B6}')).toBe(
      '(title : "hello"* OR body : "hello"* OR cjk : "hello"*)',
    )
  })
})

describe('containsUnsegmentedScript', () => {
  // The Rust CLI mirrors this classification (`apps/cli/src/keys.rs`) — the
  // same inputs must classify the same way there.
  it('detects scripts written without word separators', () => {
    expect(containsUnsegmentedScript('東京')).toBe(true) // Han
    expect(containsUnsegmentedScript('とうきょう')).toBe(true) // Hiragana
    expect(containsUnsegmentedScript('トウキョウ')).toBe(true) // Katakana
    expect(containsUnsegmentedScript('人々')).toBe(true) // iteration mark
    expect(containsUnsegmentedScript('서울')).toBe(true) // Hangul
    expect(containsUnsegmentedScript('กรุงเทพ')).toBe(true) // Thai
    expect(containsUnsegmentedScript('𠮷野')).toBe(true) // CJK Extension B
    expect(containsUnsegmentedScript('東京trip')).toBe(true) // mixed runs count
  })

  it('rejects space-delimited scripts', () => {
    expect(containsUnsegmentedScript('tokyo')).toBe(false)
    expect(containsUnsegmentedScript('café')).toBe(false)
    expect(containsUnsegmentedScript('Москва')).toBe(false)
    expect(containsUnsegmentedScript('')).toBe(false)
  })
})

describe('titleRecallNeedles', () => {
  it('anchors space-delimited terms at word starts and leaves unsegmented terms free', () => {
    // The leading space pairs with `instr(' ' || title_key, needle)`: `car`
    // may match `Car log` but never mid-word in `Oscar party`, while `東京`
    // must match anywhere — `unicode61` gives its title run no word starts.
    expect(titleRecallNeedles('Tokyo 東京')).toEqual([' tokyo', '東京'])
    expect(titleRecallNeedles('car')).toEqual([' car'])
  })

  it('folds terms the way titles were folded at index time', () => {
    expect(titleRecallNeedles('  QuOkKa   Habitat ')).toEqual([' quokka', ' habitat'])
  })

  it('returns no needles for a blank query', () => {
    expect(titleRecallNeedles('   ')).toEqual([])
  })
})

describe('isSentenceLike', () => {
  it('treats a few keywords as keywords', () => {
    expect(isSentenceLike('budget offsite')).toBe(false)
    expect(isSentenceLike('wombat storage formats')).toBe(false)
    // CJK counts a word per two characters: 会议记录 is two words.
    expect(isSentenceLike('会议记录')).toBe(false)
    expect(isSentenceLike('机器学习论文')).toBe(false)
  })

  it('treats four words or more as a sentence, function words included', () => {
    expect(isSentenceLike('where did we land on pricing')).toBe(true)
    expect(isSentenceLike('上周的会议记录')).toBe(true)
  })
})

describe('buildFtsAnyMatch', () => {
  it('lets any word count, prefixing the longer ones', () => {
    expect(buildFtsAnyMatch('Planning the Q3 offsite meetings')).toBe(
      '"planning"* OR "q3" OR "offsite"* OR "meetings"*',
    )
  })

  it('drops stopwords, one-letter words and repeats', () => {
    expect(buildFtsAnyMatch('the a of Wombat wombat format')).toBe('"wombat"* OR "format"*')
  })

  it('splits CJK runs into character pairs and keeps Latin words around them', () => {
    expect(buildFtsAnyMatch('我们去東京 用Python')).toBe(
      '"python"* OR cjk : "我们" OR cjk : "们去" OR cjk : "去東" OR cjk : "東京" OR cjk : "用"',
    )
  })

  it('quotes FTS5 syntax so user input cannot become operators', () => {
    expect(buildFtsAnyMatch('alpha OR beta* NEAR("gamma")')).toBe(
      '"alpha"* OR "beta"* OR "near"* OR "gamma"*',
    )
  })

  it('returns null when nothing is searchable', () => {
    expect(buildFtsAnyMatch('')).toBeNull()
    expect(buildFtsAnyMatch('the - a')).toBeNull()
  })
})
