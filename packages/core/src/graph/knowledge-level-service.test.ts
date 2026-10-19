import { describe, expect, it } from 'vitest'
import { createTestGraphSessionService } from '../testing/graph-session.ts'
import { createTestNoteFileService } from '../testing/graph.ts'
import { createKnowledgeLevelService } from './knowledge-level-service.ts'
import { KNOWLEDGE_LEVELS_PATH, type KnowledgeLevels } from './knowledge-levels.ts'

const CONFIG: KnowledgeLevels = {
  version: 1,
  levels: [
    { level: 1, label: 'Capture' },
    { level: 4, label: 'Wiki' },
  ],
  rules: [
    { path: 'raw', match: 'segment', level: 1 },
    { path: 'wiki', match: 'tree', level: 4 },
  ],
}

describe('createKnowledgeLevelService', () => {
  it('reads the contract of the open graph, pinned to its session', async () => {
    const noteFile = createTestNoteFileService({
      files: { [KNOWLEDGE_LEVELS_PATH]: JSON.stringify(CONFIG) },
    })
    const graphSession = createTestGraphSessionService({ graph: { generation: 4 } })
    const levels = createKnowledgeLevelService({ noteFile, graphSession })

    await expect(levels.load()).resolves.toEqual({ kind: 'ready', config: CONFIG })
    expect(noteFile.getReads()).toEqual([{ path: KNOWLEDGE_LEVELS_PATH, generation: 4 }])
  })

  it('treats a graph without the file as an ordinary graph', async () => {
    const levels = createKnowledgeLevelService({
      noteFile: createTestNoteFileService(),
      graphSession: createTestGraphSessionService({ graph: {} }),
    })

    await expect(levels.load()).resolves.toEqual({ kind: 'missing' })
  })

  it('assigns no levels from a contract that does not parse', async () => {
    const levels = createKnowledgeLevelService({
      noteFile: createTestNoteFileService({ files: { [KNOWLEDGE_LEVELS_PATH]: '{broken' } }),
      graphSession: createTestGraphSessionService({ graph: {} }),
    })

    await expect(levels.load()).resolves.toEqual({ kind: 'unavailable' })
  })

  it('rejects with no graph open', async () => {
    const levels = createKnowledgeLevelService({
      noteFile: createTestNoteFileService(),
      graphSession: createTestGraphSessionService({ graph: null }),
    })

    await expect(levels.load()).rejects.toMatchObject({ kind: 'noGraph' })
  })
})
