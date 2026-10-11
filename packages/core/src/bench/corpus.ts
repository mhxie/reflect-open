/**
 * A deterministic synthetic graph for the benchmarks: no real notes, but the
 * shape of a large personal graph — a few thousand notes, a tenth of them
 * dailies, a log-normal body length with a long tail, wiki links between
 * notes, tags, tasks, and CJK prose in about a third of them. Common English
 * words dominate the text, so a one-letter prefix query matches most notes,
 * as it does in a real graph.
 */

/** One generated markdown note. */
export interface CorpusNote {
  readonly path: string
  readonly source: string
  readonly mtime: number
}

/** Corpus size and shape knobs. */
export interface CorpusOptions {
  /** Total notes, dailies included. */
  readonly notes: number
  /** Share of notes that are dailies. */
  readonly dailyShare?: number
  /** Share of notes holding a CJK paragraph. */
  readonly cjkShare?: number
  /** Seed for the generator; equal seeds give equal corpora. */
  readonly seed?: number
}

const COMMON_WORDS = (
  'a about after again all also an and any are as at back be because been before but by ' +
  'can could day did do does even first for from get good had has have he her here his ' +
  'how i if in into is it its just know like make many may me more most much my new no ' +
  'not now of on one only or other our out over people said see she should so some such ' +
  'take than that the their them then there these they think this those time to two up us ' +
  'use very want was way we well were what when where which while who why will with work ' +
  'would year you your'
).split(' ')

const TOPIC_WORDS = (
  'agent algorithm analysis architecture attention benchmark cache cluster compiler ' +
  'database design distributed embedding evaluation experiment gradient graph hardware ' +
  'index inference kernel latency layer memory meeting model network optimizer paper ' +
  'pipeline planning project query reading research review runtime scheduler search ' +
  'serving storage strategy system throughput training transformer vector workflow'
).split(' ')

const SYLLABLES = 'ka lo mi ra ton vel qua sen dor fi zu nex pli gar tho win bel cor dra eph'.split(
  ' ',
)

const CJK_CHARACTERS =
  '的一是在不了有和人这中大为上个国我以要他时来用们生到作地于出就分对成会可主发年动同工也能下过子说产种面而方后多定行学法所民得经十三之进着等部度家电力里如水化高自二理起小物现实加量都两体制机当使点从业本去把性好应开它合还因由其些然前外天政四日那社义事平形相全表间样与关各重新线内数正心反你明看原又么利比或但质气第向道命此变条只没结解问意建月公无系军很情者最立代想已通并提直题党程展五果料象员革位入常文总次品式活设及管特件长求老头基资边流路级少图山统接知较将组见计别她手角期根论运农指几九区强放决西被干做必战先回则任取据处理事务模型训练推理系统数据计算网络存储调度延迟吞吐缓存向量检索'

const CJK_CHARACTER_LIST = [...CJK_CHARACTERS]

const TAGS = ['reading', 'idea', 'todo', 'meeting', 'research', 'wiki', 'journal', 'project']

/** Mulberry32: a tiny seeded PRNG, so a corpus is reproducible from its seed. */
function createRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}

interface Generator {
  readonly random: () => number
  pick: <Item>(items: readonly Item[]) => Item
  /** A standard normal sample (Box–Muller). */
  normal: () => number
}

function createGenerator(seed: number): Generator {
  const random = createRandom(seed)
  return {
    random,
    pick: (items) => items[Math.floor(random() * items.length)]!,
    normal: () => {
      const radius = Math.sqrt(-2 * Math.log(1 - random()))
      return radius * Math.cos(2 * Math.PI * random())
    },
  }
}

function buildRareWords(generator: Generator, count: number): string[] {
  const words = new Set<string>()
  while (words.size < count) {
    const syllables = 2 + Math.floor(generator.random() * 3)
    let word = ''
    for (let index = 0; index < syllables; index += 1) {
      word += generator.pick(SYLLABLES)
    }
    words.add(word)
  }
  return [...words]
}

/** Zipf-ish word choice: mostly common words, then topics, then a long tail. */
function nextWord(generator: Generator, rareWords: readonly string[]): string {
  const roll = generator.random()
  if (roll < 0.62) {
    return generator.pick(COMMON_WORDS)
  }
  if (roll < 0.85) {
    return generator.pick(TOPIC_WORDS)
  }
  // Squaring biases the tail toward its head, like real vocabulary.
  return rareWords[Math.floor(generator.random() ** 2 * rareWords.length)]!
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1)
}

function isoDate(epochDay: number): string {
  return new Date(epochDay * 86_400_000).toISOString().slice(0, 10)
}

/** Generate a corpus of markdown notes (see the module doc for its shape). */
export function generateCorpus(options: CorpusOptions): CorpusNote[] {
  const generator = createGenerator(options.seed ?? 20_261_011)
  const rareWords = buildRareWords(generator, 4000)
  const dailyCount = Math.round(options.notes * (options.dailyShare ?? 0.09))
  const titles = new Set<string>()
  while (titles.size < options.notes - dailyCount) {
    const length = 2 + Math.floor(generator.random() * 4)
    const words = Array.from({ length }, () =>
      generator.random() < 0.5 ? generator.pick(TOPIC_WORDS) : nextWord(generator, rareWords),
    )
    titles.add(words.map(capitalize).join(' '))
  }
  const titleList = [...titles]
  const firstDay = Math.floor(Date.UTC(2024, 0, 1) / 86_400_000)

  function sentence(): string {
    const length = 6 + Math.floor(generator.random() * 14)
    const words: string[] = []
    for (let index = 0; index < length; index += 1) {
      const roll = generator.random()
      if (roll < 0.025) {
        words.push(`[[${generator.pick(titleList)}]]`)
      } else if (roll < 0.035) {
        words.push(`**${nextWord(generator, rareWords)}**`)
      } else if (roll < 0.042) {
        words.push(`\`${nextWord(generator, rareWords)}\``)
      } else if (roll < 0.046) {
        words.push(`#${generator.pick(TAGS)}`)
      } else if (roll < 0.049) {
        words.push(`https://example.com/${nextWord(generator, rareWords)}`)
      } else {
        words.push(nextWord(generator, rareWords))
      }
    }
    return `${capitalize(words.join(' '))}.`
  }

  function cjkSentence(): string {
    const length = 12 + Math.floor(generator.random() * 30)
    let text = ''
    for (let index = 0; index < length; index += 1) {
      text += generator.pick(CJK_CHARACTER_LIST)
    }
    return `${text}。`
  }

  function block(cjk: boolean): string {
    const roll = generator.random()
    if (roll < 0.12) {
      return `## ${capitalize(sentence().slice(0, 40).trim())}`
    }
    if (roll < 0.42) {
      const items = 2 + Math.floor(generator.random() * 5)
      return Array.from({ length: items }, () => {
        const nested = generator.random() < 0.2 ? '  ' : ''
        return `${nested}- ${sentence()}`
      }).join('\n')
    }
    if (roll < 0.47) {
      return Array.from(
        { length: 1 + Math.floor(generator.random() * 3) },
        () => `- [${generator.random() < 0.4 ? 'x' : ' '}] ${sentence()}`,
      ).join('\n')
    }
    if (cjk && roll < 0.6) {
      return Array.from({ length: 1 + Math.floor(generator.random() * 3) }, cjkSentence).join('')
    }
    return Array.from({ length: 1 + Math.floor(generator.random() * 4) }, sentence).join(' ')
  }

  function body(cjk: boolean): string {
    // Log-normal length: median ~400 characters, a long tail to ~400K.
    const target = Math.min(400_000, Math.round(Math.exp(6 + 2 * generator.normal())))
    const blocks: string[] = []
    let length = 0
    do {
      const next = block(cjk)
      blocks.push(next)
      length += next.length + 2
    } while (length < target)
    return blocks.join('\n\n')
  }

  const notes: CorpusNote[] = []
  for (let index = 0; index < options.notes; index += 1) {
    const cjk = generator.random() < (options.cjkShare ?? 0.3)
    const mtime = Date.UTC(2024, 0, 1) + Math.floor(generator.random() * 1000 * 86_400_000)
    if (index < dailyCount) {
      const date = isoDate(firstDay + index)
      notes.push({ path: `daily/${date}.md`, source: `${body(cjk)}\n`, mtime })
      continue
    }
    const title = titleList[index - dailyCount]!
    const tag = generator.random() < 0.3 ? `\ntags: [${generator.pick(TAGS)}]` : ''
    notes.push({
      path: `notes/${title}.md`,
      source: `---\ncreated: ${isoDate(firstDay)}${tag}\n---\n# ${title}\n\n${body(cjk)}\n`,
      mtime,
    })
  }
  return notes
}
