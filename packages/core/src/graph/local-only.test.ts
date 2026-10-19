import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  createLocalOnlyFolders,
  isEditableLocalOnlyPath,
  isLocalOnlyPath,
  isLocalOnlyReadOnlyPath,
  localOnlyFolderRoot,
  NO_LOCAL_ONLY_FOLDERS,
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

describe('isLocalOnlyPath', () => {
  it('matches the shared fixture corpus (the Rust predicate reads the same file)', () => {
    const localOnly = createLocalOnlyFolders(fixture.folders)
    for (const testCase of fixture.cases) {
      expect(isLocalOnlyPath(localOnly, testCase.path), testCase.path).toBe(testCase.localOnly)
    }
  })

  it('treats nothing as local-only while no folders are configured', () => {
    expect(isLocalOnlyPath(NO_LOCAL_ONLY_FOLDERS, 'finance/secure/bank.md')).toBe(false)
    expect(isLocalOnlyPath(createLocalOnlyFolders([]), 'finance/secure/bank.md')).toBe(false)
  })

  it('folds configured names ASCII case-insensitively', () => {
    const localOnly = createLocalOnlyFolders(['Secure'])
    expect(isLocalOnlyPath(localOnly, 'finance/secure/bank.md')).toBe(true)
    expect(isLocalOnlyPath(localOnly, 'finance/SECURE/bank.md')).toBe(true)
  })

  it("answers for its own graph's folders only", () => {
    const secure = createLocalOnlyFolders(['secure'])
    const raw = createLocalOnlyFolders(['raw'])
    expect(isLocalOnlyPath(raw, 'finance/secure/bank.md')).toBe(false)
    expect(isLocalOnlyPath(raw, 'papers/raw/scan.png')).toBe(true)
    expect(isLocalOnlyPath(secure, 'finance/secure/bank.md')).toBe(true)
  })
})

describe('editable local-only folders', () => {
  it('match the shared editable fixture (the Rust predicates read the same file)', () => {
    const localOnly = createLocalOnlyFolders(editableFixture.folders, editableFixture.editable)
    for (const testCase of editableFixture.cases) {
      const { path } = testCase
      expect(isLocalOnlyPath(localOnly, path), `localOnly ${path}`).toBe(testCase.localOnly)
      expect(isEditableLocalOnlyPath(localOnly, path), `editable ${path}`).toBe(testCase.editable)
      expect(isLocalOnlyReadOnlyPath(localOnly, path), `read-only ${path}`).toBe(
        testCase.localOnly && !testCase.editable,
      )
      expect(localOnlyFolderRoot(localOnly, path), `folderRoot ${path}`).toBe(testCase.folderRoot)
    }
  })

  it('keeps every folder read-only unless its name is listed as editable', () => {
    const localOnly = createLocalOnlyFolders(['secure', 'archive'])
    expect(isLocalOnlyReadOnlyPath(localOnly, 'finance/secure/bank.md')).toBe(true)
    expect(isEditableLocalOnlyPath(localOnly, 'finance/secure/bank.md')).toBe(false)
  })

  it('grants nothing for an editable name that is not a configured folder', () => {
    const localOnly = createLocalOnlyFolders(['archive'], ['secure'])
    expect(isLocalOnlyPath(localOnly, 'finance/secure/bank.md')).toBe(false)
    expect(isEditableLocalOnlyPath(localOnly, 'finance/secure/bank.md')).toBe(false)
    expect(isLocalOnlyReadOnlyPath(localOnly, 'archive/2019/q1.md')).toBe(true)
  })

  it('folds editable names ASCII case-insensitively', () => {
    const localOnly = createLocalOnlyFolders(['secure'], ['SECURE'])
    expect(isEditableLocalOnlyPath(localOnly, 'finance/Secure/bank.md')).toBe(true)
  })

  it('keeps a folder read-only when only another graph lists it as editable', () => {
    const editable = createLocalOnlyFolders(['secure'], ['secure'])
    const readOnly = createLocalOnlyFolders(['secure'])
    expect(isEditableLocalOnlyPath(editable, 'finance/secure/bank.md')).toBe(true)
    expect(isEditableLocalOnlyPath(readOnly, 'finance/secure/bank.md')).toBe(false)
    expect(isLocalOnlyReadOnlyPath(readOnly, 'finance/secure/bank.md')).toBe(true)
  })
})
