import { act } from '@/test-utils/act.ts'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import { createTestCoreServices } from '@reflect/core/testing'
import { renderHookInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { useNoteAttachments, type NoteAttachments } from './use-note-attachments.ts'

function assetUrl(generation: number, path: string): string {
  return `reflect-asset://localhost/${encodeURIComponent(`${generation}/${path}`)}`
}

const embed = (target: string) => ({ target, display: '', width: null, height: null })

let attachments: NoteAttachments | null = null

afterEach(() => {
  attachments = null
})

describe('useNoteAttachments', () => {
  it('resolves from the note it renders', async () => {
    const app = createTestCoreServices({ database: createWasmTestDatabaseService() })
    app.attachments.setCatalog([
      { path: 'Projects/attachments/plan.png', size: 1 },
      { path: 'attachments/plan.png', size: 1 },
    ])
    await renderHookInApp(
      () => {
        attachments = useNoteAttachments('Projects/Plan.md')
      },
      { app, graph: { generation: 3 } },
    )

    expect(attachments?.resolveImageUrl('attachments/plan.png')).toBe(
      assetUrl(3, 'Projects/attachments/plan.png'),
    )
    expect(attachments?.resolveAttachmentPath('attachments/plan.png')).toBe(
      'Projects/attachments/plan.png',
    )
    expect(attachments?.resolveWikiEmbed(embed('Deep Work'))).toEqual({ kind: 'note' })
  })

  it('re-renders when the catalog changes', async () => {
    let renders = 0
    const { app: services } = await renderHookInApp(
      () => {
        renders += 1
        attachments = useNoteAttachments('Home.md')
      },
      { graph: { generation: 3 } },
    )
    const rendersBefore = renders
    expect(attachments?.resolveImageUrl('garden-budget.png')).toBe(assetUrl(3, 'garden-budget.png'))

    await act(() => {
      services.attachments.setCatalog([{ path: 'attachments/garden-budget.png', size: 1 }])
      services.attachments.emitCatalogChanged()
    })

    expect(renders).toBeGreaterThan(rendersBefore)
    expect(attachments?.resolveImageUrl('garden-budget.png')).toBe(
      assetUrl(3, 'attachments/garden-budget.png'),
    )
  })

  it('resolves against the new generation when the graph reopens', async () => {
    const { app } = await renderHookInApp(
      () => {
        attachments = useNoteAttachments('Home.md')
      },
      { graph: { generation: 3 } },
    )
    app.attachments.setCatalog([{ path: 'assets/cat.png', size: 1 }])
    const before = attachments

    await act(() => app.graphSession.setGraph({ generation: 4 }))

    // New resolvers, so an editor re-resolves its images.
    expect(attachments).not.toBe(before)
    expect(attachments?.resolveImageUrl('assets/cat.png')).toBe(assetUrl(4, 'assets/cat.png'))
  })

  it('resolves only remote images while no graph is open', async () => {
    await renderHookInApp(
      () => {
        attachments = useNoteAttachments('Home.md')
      },
      { graph: null },
    )

    expect(attachments?.resolveImageUrl('https://example.com/cat.png')).toBe(
      'https://example.com/cat.png',
    )
    expect(attachments?.resolveImageUrl('assets/cat.png')).toBeUndefined()
    expect(attachments?.resolveAttachmentPath('assets/cat.png')).toBeNull()
  })
})

describe('PDF embeds', () => {
  it('routes a PDF embed to the image view, which shows its first page as an <img>', async () => {
    const app = createTestCoreServices({ database: createWasmTestDatabaseService() })
    onTestFinished(() => app.database.close())
    app.attachments.setCatalog([{ path: 'Papers/paper.pdf', size: 1 }])
    await renderHookInApp(
      () => {
        attachments = useNoteAttachments('Home.md')
      },
      { app, graph: { generation: 3 } },
    )

    expect(attachments?.resolveWikiEmbed(embed('Papers/paper.pdf'))).toEqual({
      kind: 'image',
      src: '/Papers/paper.pdf',
    })
    const firstPage = `${assetUrl(3, 'Papers/paper.pdf')}?reflect-preview=pdf-page&page=1&width=480`
    expect(attachments?.resolveImageUrl('Papers/paper.pdf')).toBe(firstPage)
    expect(attachments?.resolveImageUrl('/Papers/paper.pdf')).toBe(firstPage)
  })
})

describe('useNoteAttachments for a local-only note', () => {
  it('never hands a remote image source to the webview', async () => {
    const remote = 'https://example.com/chart.png'
    const rendered: Record<string, NoteAttachments> = {}
    await renderHookInApp(
      () => {
        rendered['local'] = useNoteAttachments('finance/secure/bank.md')
        rendered['public'] = useNoteAttachments('notes/a.md')
      },
      { graph: { generation: 3, localOnlyFolders: ['secure'] } },
    )

    expect(rendered['local']?.resolveImageUrl(remote)).toBeUndefined()
    expect(rendered['public']?.resolveImageUrl(remote)).toBe(remote)
  })
})
