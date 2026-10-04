import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  isEditableLocalOnlyPath,
  isLocalOnlyPath,
  isLocalOnlyReadOnlyPath,
  localOnlyFolderRoot,
  setLocalOnlyFolders,
} from './local-only.ts'

const fixtureSchema = z.object({
  folders: z.array(z.string()),
  cases: z.array(z.object({ path: z.string(), localOnly: z.boolean() })),
})

const fixture = fixtureSchema.parse(
  JSON.parse(
    readFileSync(new URL('../../../../fixtures/local-only-paths.json', import.meta.url), 'utf8'),
  ),
)

const editableFixtureSchema = z.object({
  folders: z.array(z.string()),
  editable: z.array(z.string()),
  cases: z.array(
    z.object({
      path: z.string(),
      localOnly: z.boolean(),
      editable: z.boolean(),
      folderEntry: z.boolean(),
      folderRoot: z.string().nullable(),
    }),
  ),
})

const editableFixture = editableFixtureSchema.parse(
  JSON.parse(
    readFileSync(new URL('../../../../fixtures/local-only-editable.json', import.meta.url), 'utf8'),
  ),
)

afterEach(() => {
  setLocalOnlyFolders([])
})

describe('isLocalOnlyPath', () => {
  it('matches the shared fixture corpus (the Rust predicate reads the same file)', () => {
    setLocalOnlyFolders(fixture.folders)
    for (const testCase of fixture.cases) {
      expect(isLocalOnlyPath(testCase.path), testCase.path).toBe(testCase.localOnly)
    }
  })

  it('treats nothing as local-only while no folders are configured', () => {
    expect(isLocalOnlyPath('finance/secure/bank.md')).toBe(false)
  })

  it('folds configured names ASCII case-insensitively', () => {
    setLocalOnlyFolders(['Secure'])
    expect(isLocalOnlyPath('finance/secure/bank.md')).toBe(true)
    expect(isLocalOnlyPath('finance/SECURE/bank.md')).toBe(true)
  })

  it('follows the open graph: a new set replaces the previous one', () => {
    setLocalOnlyFolders(['secure'])
    setLocalOnlyFolders(['raw'])
    expect(isLocalOnlyPath('finance/secure/bank.md')).toBe(false)
    expect(isLocalOnlyPath('papers/raw/scan.png')).toBe(true)
  })
})

describe('editable local-only folders', () => {
  it('match the shared editable fixture (the Rust predicates read the same file)', () => {
    setLocalOnlyFolders(editableFixture.folders, editableFixture.editable)
    for (const testCase of editableFixture.cases) {
      const { path } = testCase
      expect(isLocalOnlyPath(path), `localOnly ${path}`).toBe(testCase.localOnly)
      expect(isEditableLocalOnlyPath(path), `editable ${path}`).toBe(testCase.editable)
      expect(isLocalOnlyReadOnlyPath(path), `read-only ${path}`).toBe(
        testCase.localOnly && !testCase.editable,
      )
      expect(localOnlyFolderRoot(path), `folderRoot ${path}`).toBe(testCase.folderRoot)
    }
  })

  it('keeps every folder read-only unless its name is listed as editable', () => {
    setLocalOnlyFolders(['secure', 'archive'])
    expect(isLocalOnlyReadOnlyPath('finance/secure/bank.md')).toBe(true)
    expect(isEditableLocalOnlyPath('finance/secure/bank.md')).toBe(false)
  })

  it('grants nothing for an editable name that is not a configured folder', () => {
    setLocalOnlyFolders(['archive'], ['secure'])
    expect(isLocalOnlyPath('finance/secure/bank.md')).toBe(false)
    expect(isEditableLocalOnlyPath('finance/secure/bank.md')).toBe(false)
    expect(isLocalOnlyReadOnlyPath('archive/2019/q1.md')).toBe(true)
  })

  it('folds editable names ASCII case-insensitively', () => {
    setLocalOnlyFolders(['secure'], ['SECURE'])
    expect(isEditableLocalOnlyPath('finance/Secure/bank.md')).toBe(true)
  })

  it('drops the editable names along with the folders when the graph changes', () => {
    setLocalOnlyFolders(['secure'], ['secure'])
    setLocalOnlyFolders(['secure'])
    expect(isEditableLocalOnlyPath('finance/secure/bank.md')).toBe(false)
    expect(isLocalOnlyReadOnlyPath('finance/secure/bank.md')).toBe(true)
  })
})
