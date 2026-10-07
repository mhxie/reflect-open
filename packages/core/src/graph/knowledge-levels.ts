import { z } from 'zod'
import { readNoteOrNull } from './patch-note.ts'

/** Derived by the graph's knowledge harness; Reflect only reads this contract. */
export const KNOWLEDGE_LEVELS_PATH = '.reflect/knowledge-levels.json'

const levelSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)])
const relativePathSchema = z
  .string()
  .min(1)
  .refine(
    (path) =>
      !path.includes('\\') &&
      !path.includes(':') &&
      path.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
  )
const ruleSchema = z
  .strictObject({
    path: relativePathSchema,
    match: z.enum(['tree', 'file', 'segment']),
    level: levelSchema,
    role: z.literal('shadow').optional(),
  })
  .refine((rule) => rule.match !== 'segment' || !rule.path.includes('/'))
const knowledgeLevelsSchema = z
  .strictObject({
    version: z.literal(1),
    levels: z.array(z.strictObject({ level: levelSchema, label: z.string().trim().min(1) })),
    rules: z.array(ruleSchema),
  })
  .refine((config) => {
    const levels = new Set(config.levels.map((level) => level.level))
    if (levels.size !== config.levels.length) return false
    const assignments = new Map<string, string>()
    return config.rules.every((rule) => {
      if (!levels.has(rule.level)) return false
      const key = `${rule.match}:${rule.path}`
      const assignment = `${rule.level}:${rule.role ?? ''}`
      const previous = assignments.get(key)
      assignments.set(key, assignment)
      return previous === undefined || previous === assignment
    })
  })

/** Shared versioned path rules and labels supplied by the graph's canonical harness. */
export type KnowledgeLevels = z.infer<typeof knowledgeLevelsSchema>

export interface KnowledgeClassification {
  readonly level: 1 | 2 | 3 | 4
  readonly label: string
  readonly role?: 'shadow'
}

/** An absent contract is an ordinary graph; an invalid one cannot assign levels. */
export type KnowledgeLevelsState =
  | { readonly kind: 'missing' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'ready'; readonly config: KnowledgeLevels }

/** Parse without repairing paths, inventing default levels, or inferring validation status. */
export function parseKnowledgeLevels(source: string): KnowledgeLevelsState {
  try {
    const parsed = knowledgeLevelsSchema.safeParse(JSON.parse(source))
    return parsed.success ? { kind: 'ready', config: parsed.data } : { kind: 'unavailable' }
  } catch {
    return { kind: 'unavailable' }
  }
}

/** Load the fixed graph-relative contract, pinned to the issuing graph session. */
export async function loadKnowledgeLevels(generation: number): Promise<KnowledgeLevelsState> {
  const source = await readNoteOrNull(KNOWLEDGE_LEVELS_PATH, generation)
  return source === null ? { kind: 'missing' } : parseKnowledgeLevels(source)
}

/**
 * Exact files outrank folder rules; deeper matching tree/segment rules then
 * win. The first rule wins ties. A path outside the rules stays unclassified.
 */
export function classifyKnowledgePath(
  path: string,
  config: KnowledgeLevels,
): KnowledgeClassification | null {
  if (!relativePathSchema.safeParse(path).success) return null
  const segments = path.split('/')
  let winner: KnowledgeLevels['rules'][number] | undefined
  let specificity = -1
  for (const rule of config.rules) {
    let depth = -1
    if (rule.match === 'file') {
      if (path === rule.path) depth = Infinity
    } else if (rule.match === 'tree') {
      if (path.startsWith(`${rule.path}/`)) depth = rule.path.split('/').length
    } else {
      const index = segments.slice(0, -1).lastIndexOf(rule.path)
      if (index !== -1) depth = index + 1
    }
    if (depth > specificity) {
      specificity = depth
      winner = rule
    }
  }
  const definition = config.levels.find((level) => level.level === winner?.level)
  return winner === undefined || definition === undefined
    ? null
    : {
        level: winner.level,
        label: definition.label,
        ...(winner.role === undefined ? {} : { role: winner.role }),
      }
}
