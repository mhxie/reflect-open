import { describe, expect, it } from 'vitest'
import { imageThumbnailWidthBucket } from './image-thumbnails.ts'

describe('imageThumbnailWidthBucket', () => {
  it('rounds up to the next bucket and caps at the largest', () => {
    expect(imageThumbnailWidthBucket(1)).toBe(320)
    expect(imageThumbnailWidthBucket(320)).toBe(320)
    expect(imageThumbnailWidthBucket(321)).toBe(640)
    expect(imageThumbnailWidthBucket(5000)).toBe(1280)
  })
})
