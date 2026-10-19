import { describe, expect, it } from 'vitest'
import { createPathService, createPosixPathTransport } from './path-service.ts'

describe('createPathService', () => {
  it('derives the iCloud Drive root from the home directory', async () => {
    const path = createPathService({ transport: createPosixPathTransport('/Users/alex') })
    await expect(path.homeDir()).resolves.toBe('/Users/alex')
    await expect(path.icloudDriveRoot()).resolves.toBe(
      '/Users/alex/Library/Mobile Documents/com~apple~CloudDocs',
    )
  })
})

describe('createPosixPathTransport', () => {
  it('joins with POSIX syntax', async () => {
    const transport = createPosixPathTransport('/')
    const join = (...parts: string[]) => transport.join(...parts)
    await expect(join('/g', 'notes/a.md')).resolves.toBe('/g/notes/a.md')
    await expect(join('/g/', '/notes/', './a.md')).resolves.toBe('/g/notes/a.md')
    await expect(join('/g', '../h', 'a.md')).resolves.toBe('/h/a.md')
    await expect(join('/', '..')).resolves.toBe('/')
    await expect(join('a', '..', '..', 'b')).resolves.toBe('../b')
    await expect(join('')).resolves.toBe('.')
  })
})
