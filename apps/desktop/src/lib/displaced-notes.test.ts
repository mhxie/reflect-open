import type { DisplacedFile } from '@reflect/core'
import { describe, expect, it } from 'vitest'
import { displacedNotesMessage } from './displaced-notes.ts'

function displaced(from: string, to: string, differentNote = false): DisplacedFile {
  return { from, to, keptOut: false, tracked: false, differentNote }
}

describe('displacedNotesMessage', () => {
  it('names the copy and the path the other device’s version took', () => {
    expect(
      displacedNotesMessage([
        displaced('daily/2026-10-04.md', 'daily/2026-10-04 (this device).md'),
      ]),
    ).toBe(
      'Another device also changed “daily/2026-10-04.md”, so this device’s version is now “daily/2026-10-04 (this device).md”.',
    )
  })

  it('says so when a different note took the path', () => {
    expect(
      displacedNotesMessage([displaced('notes/plan.md', 'notes/plan (this device).md', true)]),
    ).toBe(
      'Another device created a different note at “notes/plan.md”, so this device’s note is now “notes/plan (this device).md”.',
    )
  })

  it('names every copy of a pull that moved several', () => {
    expect(
      displacedNotesMessage([
        displaced('notes/a.md', 'notes/a (this device).md'),
        displaced('notes/b.md', 'notes/b (this device).md'),
      ]),
    ).toBe(
      'Other devices also changed 2 files, so this device’s versions are now “notes/a (this device).md”, “notes/b (this device).md”.',
    )
  })
})
