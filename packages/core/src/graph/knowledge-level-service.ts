import { requireGraphSession, type GraphSessionSource } from './graph-session.ts'
import {
  KNOWLEDGE_LEVELS_PATH,
  parseKnowledgeLevels,
  type KnowledgeLevelsState,
} from './knowledge-levels.ts'
import type { NoteFileService } from './note-file-service.ts'
import { readNoteOrNull } from './patch-note.ts'

/**
 * The services a {@link KnowledgeLevelService} runs on.
 */
export interface KnowledgeLevelServiceDeps {
  readonly noteFile: NoteFileService
  readonly graphSession: GraphSessionSource
}

/**
 * The open graph's knowledge-level contract: the versioned path rules and
 * labels its harness derives into {@link KNOWLEDGE_LEVELS_PATH}. Reflect only
 * reads the contract; `classifyKnowledgePath` applies it to a note path.
 */
export interface KnowledgeLevelService {
  /**
   * Read the open graph's contract, pinned to the session open at the call.
   * A missing file is an ordinary graph (`missing`); one that does not parse
   * assigns no levels (`unavailable`). Rejects when no graph is open.
   */
  load(): Promise<KnowledgeLevelsState>
}

class KnowledgeLevelServiceImpl implements KnowledgeLevelService {
  readonly #deps: KnowledgeLevelServiceDeps

  constructor(deps: KnowledgeLevelServiceDeps) {
    this.#deps = deps
  }

  async load(): Promise<KnowledgeLevelsState> {
    const { noteFile, graphSession } = this.#deps
    const { generation } = requireGraphSession(graphSession)
    const source = await readNoteOrNull(noteFile, KNOWLEDGE_LEVELS_PATH, generation)
    return source === null ? { kind: 'missing' } : parseKnowledgeLevels(source)
  }
}

export function createKnowledgeLevelService(
  deps: KnowledgeLevelServiceDeps,
): KnowledgeLevelService {
  return new KnowledgeLevelServiceImpl(deps)
}
