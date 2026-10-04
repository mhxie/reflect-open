import { describe, expect, it } from 'vitest'
import type { AttachmentLibraryEntry } from '@reflect/core'
import {
  attachmentFilename,
  attachmentPreviewAction,
  attachmentPreviewRatio,
  attachmentThumbnail,
} from './attachment-media.ts'

function entry(
  path: string,
  type: AttachmentLibraryEntry['type'],
  placeholder = false,
): AttachmentLibraryEntry {
  return { path, type, size: 1, modifiedMs: 1, placeholder, notes: [] }
}

describe('attachmentThumbnail', () => {
  it('thumbnails raster images and PDF pages, and tiles everything else', () => {
    expect(attachmentThumbnail(entry('assets/a.JPG', 'image'))).toBe('raster')
    expect(attachmentThumbnail(entry('assets/a.webp', 'image'))).toBe('raster')
    expect(attachmentThumbnail(entry('assets/a.pdf', 'pdf'))).toBe('pdf-page')
    expect(attachmentThumbnail(entry('assets/a.svg', 'image'))).toBe('tile')
    expect(attachmentThumbnail(entry('assets/a.heic', 'image'))).toBe('tile')
    expect(attachmentThumbnail(entry('assets/a.mp4', 'video'))).toBe('tile')
    expect(attachmentThumbnail(entry('assets/a.m4a', 'audio'))).toBe('tile')
  })

  it('never reads an iCloud placeholder', () => {
    expect(attachmentThumbnail(entry('assets/a.png', 'image', true))).toBe('tile')
    expect(attachmentThumbnail(entry('assets/a.pdf', 'pdf', true))).toBe('tile')
  })
})

describe('attachmentPreviewAction', () => {
  it('opens inline-renderable images in the lightbox and PDFs in Peek', () => {
    expect(attachmentPreviewAction(entry('assets/a.png', 'image'))).toBe('lightbox')
    expect(attachmentPreviewAction(entry('assets/a.svg', 'image'))).toBe('lightbox')
    expect(attachmentPreviewAction(entry('assets/a.pdf', 'pdf'))).toBe('peek')
  })

  it('opens everything else in the default app', () => {
    expect(attachmentPreviewAction(entry('assets/a.heic', 'image'))).toBe('open')
    expect(attachmentPreviewAction(entry('assets/a.mov', 'video'))).toBe('open')
    expect(attachmentPreviewAction(entry('assets/a.mp3', 'audio'))).toBe('open')
    expect(attachmentPreviewAction(entry('assets/a.png', 'image', true))).toBe('open')
  })

  it('opens an image whose thumbnail failed externally, but keeps PDFs in Peek', () => {
    expect(attachmentPreviewAction(entry('assets/a.png', 'image'), true)).toBe('open')
    expect(attachmentPreviewAction(entry('assets/a.pdf', 'pdf'), true)).toBe('peek')
  })
})

describe('attachmentPreviewRatio', () => {
  it('uses the loaded media ratio, held to a sane range', () => {
    expect(attachmentPreviewRatio(entry('assets/a.png', 'image'), 0.5)).toBe(0.5)
    expect(attachmentPreviewRatio(entry('assets/a.png', 'image'), 3)).toBe(1.8)
    expect(attachmentPreviewRatio(entry('assets/a.png', 'image'), 0.1)).toBe(0.4)
  })

  it('falls back to a per-kind default before the media loads', () => {
    expect(attachmentPreviewRatio(entry('assets/a.png', 'image'), undefined)).toBe(0.75)
    expect(attachmentPreviewRatio(entry('assets/a.pdf', 'pdf'), undefined)).toBeCloseTo(1.294, 3)
  })

  it('gives tiles a fixed shape whatever was reported', () => {
    expect(attachmentPreviewRatio(entry('assets/a.mp4', 'video'), 2)).toBe(9 / 16)
    expect(attachmentPreviewRatio(entry('assets/a.mp3', 'audio'), undefined)).toBe(0.45)
  })
})

describe('attachmentFilename', () => {
  it('is the last path segment', () => {
    expect(attachmentFilename('notes/assets/photo.png')).toBe('photo.png')
    expect(attachmentFilename('photo.png')).toBe('photo.png')
  })
})
