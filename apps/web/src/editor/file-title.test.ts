import { describe, expect, it } from 'vitest'
import { noteTitleFromFile } from './file-title.ts'

describe('noteTitleFromFile', () => {
  it('titles a note with the file name minus its extension', () => {
    expect(noteTitleFromFile({ name: 'socc20-serverless.pdf', type: 'application/pdf' })).toBe(
      'socc20-serverless',
    )
    expect(noteTitleFromFile({ name: 'Q3 Report.final.docx' })).toBe('Q3 Report.final')
    expect(noteTitleFromFile({ name: 'README' })).toBe('README')
  })

  it('gives no title for images, whose names carry no meaning', () => {
    expect(noteTitleFromFile({ name: 'image.png', type: 'image/png' })).toBeUndefined()
    expect(noteTitleFromFile({ name: 'Screenshot 2026-10-02.jpg' })).toBeUndefined()
  })

  it('gives no title for a blank name', () => {
    expect(noteTitleFromFile({ name: '  .pdf' })).toBeUndefined()
  })
})
