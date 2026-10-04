import { describe, expect, it } from 'vitest'
import { attachmentTypeOf } from './attachment-types.ts'

describe('attachmentTypeOf', () => {
  it('classifies media files by extension, case-insensitively', () => {
    expect(attachmentTypeOf('assets/photo.PNG')).toBe('image')
    expect(attachmentTypeOf('assets/scan.heic')).toBe('image')
    expect(attachmentTypeOf('assets/report.pdf')).toBe('pdf')
    expect(attachmentTypeOf('assets/clip.mov')).toBe('video')
    expect(attachmentTypeOf('assets/song.mp3')).toBe('audio')
  })

  it('returns null for non-media attachments and extensionless names', () => {
    expect(attachmentTypeOf('assets/archive.zip')).toBeNull()
    expect(attachmentTypeOf('assets/table.csv')).toBeNull()
    expect(attachmentTypeOf('assets/README')).toBeNull()
    expect(attachmentTypeOf('assets/.png')).toBeNull()
    expect(attachmentTypeOf('assets.d/notes')).toBeNull()
  })

  it('treats a recording in an audio-memos tree as audio whatever its container', () => {
    expect(attachmentTypeOf('audio-memos/2026-10-03.webm')).toBe('audio')
    expect(attachmentTypeOf('notes/audio-memos/memo.webm')).toBe('audio')
    expect(attachmentTypeOf('assets/screen-recording.webm')).toBe('video')
    expect(attachmentTypeOf('my-audio-memos/clip.webm')).toBe('video')
  })
})
