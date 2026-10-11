import { describe, test } from 'vitest'
import { buildIndexedNote } from '../indexing/indexed-note.ts'
import { parseNote } from '../markdown/index.ts'
import { benchCorpus } from './bench-index.ts'

/**
 * The CPU half of an index pass (`buildNoteProjection`): parse a note, then
 * flatten it into its index projection. A rebuild runs both over every note;
 * a reconcile or a save runs them for the changed notes only.
 */

const parse = parseNote
const project = buildIndexedNote
const notes = benchCorpus().slice(0, 1000)
const parsed = notes.map((note) => parse({ path: note.path, source: note.source }))
const bytes = notes.reduce((total, note) => total + note.source.length, 0)
const run = { time: 2000, iterations: 5, warmupIterations: 1 }

// One 50,000-character paragraph of prose, links, and inline syntax: the
// inline parse runs per paragraph, so its cost must stay linear in length.
const LONG_PARAGRAPH_WORDS =
  'the model [[Serving Notes]] **latency** and a `cache` see [docs](https://example.com) for'
const longParagraph = { path: 'notes/long.md', source: '' }
while (longParagraph.source.length < 50_000) {
  longParagraph.source += `${LONG_PARAGRAPH_WORDS} `
}

describe(`index projection — ${notes.length} synthetic notes, ${(bytes / 1e6).toFixed(1)} MB`, () => {
  test('parse', async ({ bench }) => {
    await bench('parseNote', () => {
      for (const note of notes) {
        parse({ path: note.path, source: note.source })
      }
    }).run(run)
  })

  test('long paragraph', async ({ bench }) => {
    await bench('parseNote, one 50K-character paragraph', () => {
      parse(longParagraph)
    }).run(run)
  })

  test('project', async ({ bench }) => {
    await bench('buildIndexedNote', () => {
      for (const [index, note] of notes.entries()) {
        project(parsed[index]!, { fileHash: '', mtime: note.mtime, source: note.source })
      }
    }).run(run)
  })
})
