import { describe, expect, it } from 'vitest'
import {
  classifyKnowledgePath,
  parseKnowledgeLevels,
  type KnowledgeLevels,
} from './knowledge-levels.ts'

const config: KnowledgeLevels = {
  version: 1,
  levels: [
    { level: 1, label: 'Capture' },
    { level: 2, label: 'Working' },
    { level: 3, label: 'Sources' },
    { level: 4, label: 'Wiki' },
  ],
  rules: [
    { path: 'raw', match: 'segment', level: 1 },
    { path: 'notes', match: 'tree', level: 2 },
    { path: 'sources', match: 'tree', level: 3 },
    { path: 'wiki', match: 'tree', level: 4 },
    { path: 'wiki-cn', match: 'tree', level: 4, role: 'shadow' },
    { path: 'notes/raw', match: 'tree', level: 3 },
    { path: 'wiki/index.md', match: 'file', level: 2 },
  ],
}

describe('knowledge level contract', () => {
  it('uses declared labels and paths without assigning levels outside the rules', () => {
    expect(parseKnowledgeLevels(JSON.stringify(config))).toEqual({ kind: 'ready', config })
    expect(classifyKnowledgePath('notes/idea.md', config)).toEqual({ level: 2, label: 'Working' })
    expect(classifyKnowledgePath('sources/paper.md', config)).toEqual({
      level: 3,
      label: 'Sources',
    })
    expect(classifyKnowledgePath('wiki/topic.md', config)).toEqual({ level: 4, label: 'Wiki' })
    expect(classifyKnowledgePath('wiki-cn/topic.md', config)).toEqual({
      level: 4,
      label: 'Wiki',
      role: 'shadow',
    })
    for (const path of [
      'wiki-other/topic.md',
      'unknown/topic.md',
      '../wiki/topic.md',
      '/wiki/topic.md',
    ]) {
      expect(classifyKnowledgePath(path, config)).toBeNull()
    }
  })

  it('prefers exact files then deepest folders or segments, retaining the first rule on ties', () => {
    expect(classifyKnowledgePath('wiki/index.md', config)).toEqual({ level: 2, label: 'Working' })
    expect(classifyKnowledgePath('wiki/topic/raw/capture.md', config)).toEqual({
      level: 1,
      label: 'Capture',
    })
    expect(classifyKnowledgePath('notes/raw/capture.md', config)).toEqual({
      level: 1,
      label: 'Capture',
    })
    expect(classifyKnowledgePath('wiki/raw.md', config)).toEqual({ level: 4, label: 'Wiki' })
    expect(classifyKnowledgePath('other/raw/topic/raw/capture.md', config)?.level).toBe(1)
  })

  it('rejects unknown versions, malformed paths, ambiguous definitions and undeclared levels', () => {
    for (const candidate of [
      { ...config, version: 2 },
      { ...config, levels: [...config.levels, config.levels[0]] },
      { ...config, levels: [], rules: config.rules },
      { ...config, rules: [{ path: '../wiki', match: 'tree', level: 4 }] },
      { ...config, rules: [{ path: 'C:/wiki', match: 'tree', level: 4 }] },
      { ...config, rules: [...config.rules, { path: 'wiki', match: 'tree', level: 1 }] },
      { ...config, rules: [{ path: 'notes/raw', match: 'segment', level: 1 }] },
      { ...config, rules: [{ path: 'wiki', match: 'tree', level: 4, role: 'verified' }] },
    ])
      expect(parseKnowledgeLevels(JSON.stringify(candidate))).toEqual({ kind: 'unavailable' })
    expect(parseKnowledgeLevels('{broken')).toEqual({ kind: 'unavailable' })
    expect(
      parseKnowledgeLevels(JSON.stringify({ ...config, rules: [...config.rules, config.rules[0]] }))
        .kind,
    ).toBe('ready')
  })
})
