import { describe, expect, it, vi } from 'vitest'
import { localImagesOnly, resolveNoXPost, resolveNoYouTubeVideo } from './local-only-render.ts'

describe('localImagesOnly', () => {
  it('refuses every remote source and delegates graph attachments', async () => {
    const resolver = vi.fn((source: string) => `reflect-asset://${source}`)
    const local = localImagesOnly(resolver)
    for (const remote of [
      'https://example.com/a.png',
      'HTTP://example.com/a.png',
      '//cdn.example.com/a.png',
      'data:image/png;base64,AAAA',
      'file:///etc/hosts',
    ]) {
      expect(local(remote), remote).toBeUndefined()
    }
    expect(resolver).not.toHaveBeenCalled()
    expect(local('assets/a.png')).toBe('reflect-asset://assets/a.png')
    expect(local('../scan:1.png')).toBe('reflect-asset://../scan:1.png')
  })

  it('resolves nothing without a resolver (Meowdown would load http sources)', () => {
    expect(localImagesOnly(undefined)('https://example.com/a.png')).toBeUndefined()
    expect(localImagesOnly(undefined)('assets/a.png')).toBeUndefined()
  })
})

describe('embed resolvers for private content', () => {
  it('find nothing', async () => {
    expect(await resolveNoXPost('https://x.com/jack/status/1')).toBeUndefined()
    expect(await resolveNoYouTubeVideo('https://youtu.be/abc')).toBeUndefined()
  })
})
