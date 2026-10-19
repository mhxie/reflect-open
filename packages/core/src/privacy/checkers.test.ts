import { createTestGraphSessionService } from '../testing/graph-session.ts'
import { describe, expect, it } from 'vitest'
import type { RetrievalHit } from '../embeddings/retrieval-hit.ts'
import { createLocalOnlyFolders, NO_LOCAL_ONLY_FOLDERS } from '../graph/local-only.ts'
import { createTestNoteFileService, overrideNoteFileService } from '../testing/graph.ts'
import {
  assertCloudAllowed,
  cloudSafeAssetDescription,
  cloudSafeLinkHref,
  cloudSafeNoteContent,
  cloudSafeSelection,
  createPrivacyService,
  isPrivateNote,
  isPrivateNoteError,
  notePrivate,
  PrivateNoteError,
} from './privacy-service.ts'

// Sentinels no other string in the system (prompts included) can collide
// with — a payload assertion against them can never pass vacuously.
const PRIVATE_TITLE = 'sentinel-title-01jxq3'
const PRIVATE_PATH = 'notes/sentinel-path-01jxq3.md'
const PRIVATE_BODY = 'sentinel-body-01jxq3'

const NONE = NO_LOCAL_ONLY_FOLDERS

describe('assertCloudAllowed', () => {
  it('passes a non-private note through', () => {
    expect(() => assertCloudAllowed(NONE, { path: 'notes/a.md', isPrivate: false })).not.toThrow()
  })

  it('throws PrivateNoteError for a private note', () => {
    expect(() => assertCloudAllowed(NONE, { path: 'notes/secret.md', isPrivate: true })).toThrow(
      PrivateNoteError,
    )
  })

  it('throws PrivateNoteError for device-only derivations', () => {
    expect(() =>
      assertCloudAllowed(NONE, {
        path: 'notes/scan.md',
        isPrivate: false,
        hasDeviceOnlyContent: true,
      }),
    ).toThrow(PrivateNoteError)
  })
})

describe('cloudSafeLinkHref', () => {
  it('mints a public note link destination', () => {
    expect(
      cloudSafeLinkHref(NONE, { path: 'notes/a.md', isPrivate: false }, 'https://example.com'),
    ).toBe('https://example.com')
  })

  it('refuses a private note before the destination can be fetched', () => {
    expect(() =>
      cloudSafeLinkHref(NONE, { path: PRIVATE_PATH, isPrivate: true }, 'https://example.com'),
    ).toThrow(PrivateNoteError)
  })
})

describe('notePrivate', () => {
  it('reads the shared privacy flag from full note source', () => {
    expect(notePrivate('---\nprivate: true\n---\nsecret')).toBe(true)
    expect(notePrivate('---\nprivate: false\n---\npublic')).toBe(false)
    expect(notePrivate('no frontmatter')).toBe(false)
  })

  it('fails closed on frontmatter it cannot read', () => {
    expect(notePrivate('---\nprivate: true\ntitle: [unclosed\n---\nsecret')).toBe(true)
    expect(notePrivate('---\nprivate: no\ntitle: [unclosed\n---\nsecret')).toBe(true)
    expect(notePrivate('---\nprivate: maybe\n---\nsecret')).toBe(true)
    expect(notePrivate('\u{FEFF}---\nprivate: true\n---\nsecret')).toBe(true)
    expect(notePrivate('---\ntitle: [unclosed\n---\npublic')).toBe(false)
  })
})

describe('isPrivateNoteError', () => {
  it('recognizes the thrown refusal', () => {
    try {
      assertCloudAllowed(NONE, { path: 'notes/secret.md', isPrivate: true })
      expect.unreachable('should have thrown')
    } catch (cause) {
      expect(isPrivateNoteError(cause)).toBe(true)
    }
  })

  it('rejects other errors', () => {
    expect(isPrivateNoteError(new Error('boom'))).toBe(false)
    expect(isPrivateNoteError(null)).toBe(false)
  })
})

function setup(files: Record<string, string>, localOnlyFolders: string[] = []) {
  const localOnly = createLocalOnlyFolders(localOnlyFolders)
  const noteFile = createTestNoteFileService({ files, localOnly })
  const probed: string[] = []
  const recording = overrideNoteFileService(noteFile, {
    readShareable: async (path, generation) => {
      probed.push(path)
      return await noteFile.readShareable(path, generation)
    },
  })
  return {
    noteFile,
    probed,
    privacy: createPrivacyService({
      noteFile: recording,
      graphSession: createTestGraphSessionService({ graph: { generation: 1, localOnlyFolders } }),
    }),
  }
}

describe('isPrivateLive', () => {
  it('reads the flag from the note on disk', async () => {
    const { privacy } = setup({
      'notes/a.md': '# Public\n',
      [PRIVATE_PATH]: '---\nprivate: true\n---\n# Diary\n',
    })

    await expect(privacy.isPrivateLive('notes/a.md')).resolves.toBe(false)
    await expect(privacy.isPrivateLive(PRIVATE_PATH)).resolves.toBe(true)
  })

  it('fails closed when the note cannot be read', async () => {
    const { privacy } = setup({})

    await expect(privacy.isPrivateLive('notes/missing.md')).resolves.toBe(true)
  })

  it('fails closed with no graph open', async () => {
    const privacy = createPrivacyService({
      noteFile: createTestNoteFileService({ files: { 'notes/a.md': '# Public\n' } }),
      graphSession: createTestGraphSessionService({ graph: null }),
    })

    await expect(privacy.isPrivateLive('notes/a.md')).resolves.toBe(true)
    expect(() => privacy.assertCloudAllowed({ path: 'notes/a.md', isPrivate: false })).toThrow(
      PrivateNoteError,
    )
  })
})

describe('cloudSafeSearchHits', () => {
  const PUBLIC: RetrievalHit = {
    path: 'notes/a.md',
    title: 'Public',
    score: 1,
    snippet: 'body',
    heading: null,
    isPrivate: false,
    assetTextHash: 'a'.repeat(64),
  }
  const PRIVATE: RetrievalHit = {
    path: PRIVATE_PATH,
    title: PRIVATE_TITLE,
    score: 0.9,
    snippet: '',
    heading: null,
    isPrivate: true,
    assetTextHash: 'a'.repeat(64),
  }

  it('drops private hits entirely: not even the title survives', async () => {
    const { privacy } = setup({ 'notes/a.md': '# Public\n', [PRIVATE_PATH]: '# Diary\n' })

    const safe = await privacy.cloudSafeSearchHits([PUBLIC, PRIVATE])
    const payload = JSON.stringify(safe)
    expect(payload).not.toContain(PRIVATE_TITLE)
    expect(payload).not.toContain(PRIVATE_PATH)
    expect(safe).toEqual([
      {
        path: 'notes/a.md',
        title: 'Public',
        snippet: 'body',
        heading: null,
        assetTextHash: PUBLIC.assetTextHash,
      },
    ])
  })

  it('drops hits the live probe flags even when the index lags (TOCTOU)', async () => {
    const { privacy } = setup({
      'notes/a.md': '# Public\n',
      [PRIVATE_PATH]: '---\nprivate: true\n---\n# Diary\n',
    })
    // The stale index still says public.
    const justMarkedPrivate: RetrievalHit = { ...PRIVATE, isPrivate: false }

    const safe = await privacy.cloudSafeSearchHits([PUBLIC, justMarkedPrivate])
    const payload = JSON.stringify(safe)
    expect(payload).not.toContain(PRIVATE_TITLE)
    expect(payload).not.toContain(PRIVATE_PATH)
    expect(safe).toHaveLength(1)
  })

  it('drops a hit whose note cannot be read', async () => {
    const { privacy } = setup({})

    await expect(privacy.cloudSafeSearchHits([PUBLIC])).resolves.toEqual([])
  })

  it('never probes hits the index already flags private', async () => {
    const { privacy, probed } = setup({ 'notes/a.md': '# Public\n' })

    await privacy.cloudSafeSearchHits([PUBLIC, PRIVATE])
    expect(probed).toEqual(['notes/a.md'])
  })

  it('strips hits to the cloud-facing fields (no score, no flag)', async () => {
    const { privacy } = setup({ 'notes/a.md': '# Public\n' })

    const [hit] = await privacy.cloudSafeSearchHits([PUBLIC])
    expect(Object.keys(hit ?? {}).sort()).toEqual([
      'assetTextHash',
      'heading',
      'path',
      'snippet',
      'title',
    ])
  })

  it('withholds search snapshots that lack attachment-text identity', async () => {
    const { privacy } = setup({ 'notes/a.md': '# Public\n' })
    const withoutHash = { ...PUBLIC }
    delete withoutHash.assetTextHash

    await expect(privacy.cloudSafeSearchHits([withoutHash])).resolves.toEqual([])
  })

  it('drops a hit the extra source check restricts, and fails closed when it throws', async () => {
    const { privacy } = setup({ 'notes/a.md': '# Public\n', 'notes/b.md': '# Other\n' })
    const other: RetrievalHit = { ...PUBLIC, path: 'notes/b.md', title: 'Other' }
    const checked: Array<{ path: string; source: string }> = []

    const safe = await privacy.cloudSafeSearchHits([PUBLIC, other], (hit, source) => {
      checked.push({ path: hit.path, source })
      if (hit.path === 'notes/b.md') {
        return Promise.reject(new Error('unreadable attachment'))
      }
      return Promise.resolve(false)
    })
    expect(safe.map((hit) => hit.path)).toEqual(['notes/a.md'])
    expect(checked).toEqual([
      { path: 'notes/a.md', source: '# Public\n' },
      { path: 'notes/b.md', source: '# Other\n' },
    ])
    await expect(
      privacy.cloudSafeSearchHits([PUBLIC], () => Promise.resolve(true)),
    ).resolves.toEqual([])
  })
})

describe('cloudSafeNoteListings', () => {
  const listing = {
    title: 'Public',
    dailyDate: null,
    snippet: 'body',
    modifiedAt: '2026-06-12T00:00:00.000Z',
  }

  it('keeps public entries and drops indexed or live private ones', async () => {
    const { privacy } = setup({
      'notes/a.md': '# Public\n',
      'notes/b.md': '---\nprivate: true\n---\n# Diary\n',
    })

    const safe = await privacy.cloudSafeNoteListings([
      { ...listing, path: 'notes/a.md', isPrivate: false },
      { ...listing, path: 'notes/b.md', isPrivate: false },
      { ...listing, path: PRIVATE_PATH, isPrivate: true, title: PRIVATE_TITLE },
      { ...listing, path: 'notes/missing.md', isPrivate: false },
    ])
    expect(JSON.stringify(safe)).not.toContain(PRIVATE_TITLE)
    expect(safe).toEqual([{ ...listing, path: 'notes/a.md' }])
  })
})

describe('cloudSafeNoteContent', () => {
  it('mints content for a non-private note', () => {
    expect(
      cloudSafeNoteContent(NONE, {
        path: 'notes/a.md',
        isPrivate: false,
        title: 'A',
        content: 'body',
        truncated: false,
      }),
    ).toEqual({ path: 'notes/a.md', title: 'A', content: 'body', truncated: false })
  })

  it('refuses to mint a private note before any content escapes', () => {
    expect(() =>
      cloudSafeNoteContent(NONE, {
        path: PRIVATE_PATH,
        isPrivate: true,
        title: PRIVATE_TITLE,
        content: PRIVATE_BODY,
        truncated: false,
      }),
    ).toThrow(PrivateNoteError)
  })

  it('refuses a note whose malformed frontmatter declares it private', () => {
    const source = `---\nprivate: true\ntitle: [unclosed\n---\n${PRIVATE_BODY}`
    expect(() =>
      cloudSafeNoteContent(NONE, {
        path: PRIVATE_PATH,
        isPrivate: notePrivate(source),
        title: PRIVATE_TITLE,
        content: source,
        truncated: false,
      }),
    ).toThrow(PrivateNoteError)
  })
})

describe('cloudSafeAssetDescription', () => {
  it('mints a description for a sendable asset', () => {
    expect(
      cloudSafeAssetDescription(NONE, {
        path: 'assets/chart.png',
        isPrivate: false,
        description: 'A bar chart of Q4 revenue.',
        truncated: false,
      }),
    ).toEqual({
      path: 'assets/chart.png',
      description: 'A bar chart of Q4 revenue.',
      truncated: false,
    })
  })

  it('refuses to mint a blocked asset before any description escapes', () => {
    expect(() =>
      cloudSafeAssetDescription(NONE, {
        path: 'assets/secret.png',
        isPrivate: true,
        description: PRIVATE_BODY,
        truncated: false,
      }),
    ).toThrow(PrivateNoteError)
  })
})

describe('cloudSafeSelection', () => {
  it('mints a selection from a non-private note', () => {
    expect(
      cloudSafeSelection(NONE, { path: 'notes/a.md', isPrivate: false }, 'selected text'),
    ).toBe('selected text')
  })

  it('refuses to mint a selection from a private note', () => {
    expect(() =>
      cloudSafeSelection(NONE, { path: PRIVATE_PATH, isPrivate: true }, PRIVATE_BODY),
    ).toThrow(PrivateNoteError)
  })
})

describe('local-only folders', () => {
  // A note inside a local-only folder carries no `private: true`, yet no
  // gate may let its path, title, or content out.
  const LOCAL_PATH = 'finance/secure/sentinel-local-01jxq3.md'
  const LOCAL_TITLE = 'sentinel-local-title-01jxq3'
  const SECURE = createLocalOnlyFolders(['secure'])

  it('refuses every single-note mint by path, whatever the flag says', () => {
    const note = { path: LOCAL_PATH, isPrivate: false }
    expect(isPrivateNote(SECURE, note)).toBe(true)
    expect(() => assertCloudAllowed(SECURE, note)).toThrow(PrivateNoteError)
    expect(() =>
      cloudSafeNoteContent(SECURE, {
        ...note,
        title: LOCAL_TITLE,
        content: PRIVATE_BODY,
        truncated: false,
      }),
    ).toThrow(PrivateNoteError)
    expect(() => cloudSafeSelection(SECURE, note, PRIVATE_BODY)).toThrow(PrivateNoteError)
    expect(() => cloudSafeLinkHref(SECURE, note, 'https://example.com')).toThrow(PrivateNoteError)
    expect(() =>
      cloudSafeAssetDescription(SECURE, {
        path: 'finance/secure/scan.png',
        isPrivate: false,
        description: PRIVATE_BODY,
        truncated: false,
      }),
    ).toThrow(PrivateNoteError)
  })

  it('applies the open graph folders in every service gate', () => {
    const { privacy } = setup({}, ['secure'])
    const note = { path: LOCAL_PATH, isPrivate: false }

    expect(privacy.isPrivateNote(note)).toBe(true)
    expect(() => privacy.assertCloudAllowed(note)).toThrow(PrivateNoteError)
    expect(() => privacy.cloudSafeSelection(note, PRIVATE_BODY)).toThrow(PrivateNoteError)
    expect(() => privacy.cloudSafeLinkHref(note, 'https://example.com')).toThrow(PrivateNoteError)
    expect(() =>
      privacy.cloudSafeNoteContent({
        ...note,
        title: LOCAL_TITLE,
        content: PRIVATE_BODY,
        truncated: false,
      }),
    ).toThrow(PrivateNoteError)
  })

  it('drops local-only search hits without probing them', async () => {
    const { privacy, probed } = setup({ 'notes/a.md': '# Public\n', [LOCAL_PATH]: PRIVATE_BODY }, [
      'secure',
    ])
    const hits: RetrievalHit[] = [
      {
        path: 'notes/a.md',
        title: 'Public',
        score: 1,
        snippet: 'body',
        heading: null,
        isPrivate: false,
        assetTextHash: 'a'.repeat(64),
      },
      {
        path: LOCAL_PATH,
        title: LOCAL_TITLE,
        score: 0.9,
        snippet: PRIVATE_BODY,
        heading: null,
        isPrivate: false,
        assetTextHash: 'a'.repeat(64),
      },
    ]

    const safe = await privacy.cloudSafeSearchHits(hits)
    expect(probed).toEqual(['notes/a.md'])
    const payload = JSON.stringify(safe)
    expect(payload).not.toContain(LOCAL_PATH)
    expect(payload).not.toContain(LOCAL_TITLE)
  })

  it('drops local-only listings without probing them', async () => {
    const { privacy, probed } = setup({ 'notes/a.md': '# Public\n', [LOCAL_PATH]: PRIVATE_BODY }, [
      'secure',
    ])
    const listing = (path: string, title: string) => ({
      path,
      isPrivate: false,
      title,
      dailyDate: null,
      snippet: '',
      modifiedAt: '2026-10-01T00:00:00.000Z',
    })

    const safe = await privacy.cloudSafeNoteListings([
      listing('notes/a.md', 'Public'),
      listing(LOCAL_PATH, LOCAL_TITLE),
    ])
    expect(probed).toEqual(['notes/a.md'])
    expect(JSON.stringify(safe)).not.toContain(LOCAL_TITLE)
  })

  it('counts a note the shareable read refuses as private', async () => {
    // The folder resolves through a spelling the path rule misses; the
    // native boundary refuses it by the entry it resolves to.
    const noteFile = createTestNoteFileService({ files: { 'notes/alias.md': '# Public\n' } })
    const privacy = createPrivacyService({
      noteFile: overrideNoteFileService(noteFile, {
        readShareable: () => Promise.resolve({ kind: 'localOnly' }),
      }),
      graphSession: createTestGraphSessionService({ graph: { generation: 1 } }),
    })

    await expect(privacy.isPrivateLive('notes/alias.md')).resolves.toBe(true)
  })

  it('leaves notes outside the folders to the frontmatter flag', () => {
    expect(() =>
      assertCloudAllowed(SECURE, { path: 'finance/secured.md', isPrivate: false }),
    ).not.toThrow()
  })
})
