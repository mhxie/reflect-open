import { describe, expect, it } from 'vitest'
import { createLocalOnlyFolders, NO_LOCAL_ONLY_FOLDERS } from '../graph/local-only.ts'
import { createTestOnDeviceModelService } from '../testing/ai.ts'
import {
  localSafeAssetDescription,
  localSafeNoteContent,
  localSafeNoteListing,
  localSafeSearchHit,
} from './local-checkers.ts'
import { modelTarget, type VerifiedOnDeviceTarget } from './on-device.ts'

async function localTarget(): Promise<VerifiedOnDeviceTarget> {
  const target = await createTestOnDeviceModelService().verify(
    modelTarget({
      id: 'local',
      provider: 'openai-compatible',
      model: 'local',
      baseUrl: 'http://localhost:1234/v1',
      keyHint: '',
      onDevice: {
        baseUrl: 'http://localhost:1234/v1',
        model: 'local',
        server: 'openai-compatible',
      },
    }),
    '',
  )
  if (target.kind !== 'on-device') {
    throw new Error('expected an on-device target')
  }
  return target
}

describe('local-safe provenance', () => {
  it('leaves public values unmarked', async () => {
    const target = await localTarget()
    const listing = localSafeNoteListing(NO_LOCAL_ONLY_FOLDERS, target, {
      path: 'notes/plan.md',
      isPrivate: false,
      title: 'Plan',
      dailyDate: null,
      snippet: '',
      modifiedAt: '2026-10-07T00:00:00Z',
    })
    expect(listing.reflectPrivateContext).toBeUndefined()
  })

  it('marks every value whose note must stay on the device', async () => {
    const target = await localTarget()
    const vault = createLocalOnlyFolders(['vault'])
    const content = { title: 'Plan', content: 'body', truncated: false }

    expect(
      localSafeNoteContent(vault, target, { ...content, path: 'notes/plan.md', isPrivate: true })
        .reflectPrivateContext,
    ).toBe(true)
    expect(
      localSafeNoteContent(vault, target, { ...content, path: 'vault/plan.md', isPrivate: false })
        .reflectPrivateContext,
    ).toBe(true)
    expect(
      localSafeNoteContent(vault, target, {
        ...content,
        path: 'notes/plan.md',
        isPrivate: false,
        hasDeviceOnlyContent: true,
      }).reflectPrivateContext,
    ).toBe(true)
    expect(
      localSafeAssetDescription(vault, target, {
        path: 'vault/scan.png',
        isPrivate: false,
        description: 'text',
        truncated: false,
      }).reflectPrivateContext,
    ).toBe(true)
  })

  it('marks a search hit without an attachment-text identity', async () => {
    const target = await localTarget()
    const hit = {
      path: 'notes/plan.md',
      title: 'Plan',
      snippet: '',
      heading: null,
      isPrivate: false,
    }

    expect(localSafeSearchHit(NO_LOCAL_ONLY_FOLDERS, target, hit).reflectPrivateContext).toBe(true)
    expect(
      localSafeSearchHit(NO_LOCAL_ONLY_FOLDERS, target, { ...hit, assetTextHash: 'hash' })
        .reflectPrivateContext,
    ).toBeUndefined()
  })
})
