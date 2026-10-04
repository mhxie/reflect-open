import { describe, expect, it } from 'vitest'
import { shouldEmbedFile } from './embed-file.ts'

describe('shouldEmbedFile', () => {
  it('embeds images and files named .pdf', () => {
    expect(shouldEmbedFile({ name: 'chart.png', type: 'image/png' })).toBe(true)
    expect(shouldEmbedFile({ name: 'paper.pdf', type: 'application/pdf' })).toBe(true)
    expect(shouldEmbedFile({ name: 'Paper.PDF' })).toBe(true)
  })

  it('links a PDF whose name lacks .pdf, which could not preview', () => {
    expect(shouldEmbedFile({ name: 'paper', type: 'application/pdf' })).toBe(false)
    expect(shouldEmbedFile({ name: 'notes.docx' })).toBe(false)
  })
})
