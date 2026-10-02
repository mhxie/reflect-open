import { describe, expect, it } from 'vitest'
import { PDF_PAGE_WIDTH_BUCKETS, pdfPageWidthBucket } from './pdf-pages.ts'

describe('pdfPageWidthBucket', () => {
  it('rounds a width up to the next bucket', () => {
    expect(pdfPageWidthBucket(1)).toBe(480)
    expect(pdfPageWidthBucket(480)).toBe(480)
    expect(pdfPageWidthBucket(481)).toBe(960)
    expect(pdfPageWidthBucket(750)).toBe(960)
  })

  it('caps at the largest bucket', () => {
    expect(pdfPageWidthBucket(5000)).toBe(PDF_PAGE_WIDTH_BUCKETS.at(-1))
  })
})
