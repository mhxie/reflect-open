import { setTestDatabaseOpener } from '@reflect/core/testing'
import '@/styles/index.css'

// Importing `@reflect/core` here would load it before a test file's `vi.mock` of it.

// `createTestDatabaseService()` is Node.js only, so every test double that
// defaults to it gets the wasm index here. The import waits for the first
// query: tests that never read the index load nothing.
setTestDatabaseOpener(async () => {
  const { createWasmTestDatabaseService } = await import('./test-database.ts')
  return await createWasmTestDatabaseService()
})
