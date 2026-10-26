import type { ReactElement, ReactNode } from 'react'
import { act } from '@/test-utils/act.ts'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { AppServices } from '@reflect/app'
import { createTestDialogService } from '@reflect/app/testing'
import type { AppPlatform, CoreServices, RecentGraph } from '@reflect/core'
import {
  createTestCoreServices,
  createTestGraphSessionService,
  createTestIpcBridgeService,
  createTestMobileStorageService,
  createTestPlatformService,
} from '@reflect/core/testing'
import { useGraphServices } from '@/services/services-provider.tsx'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { GraphProvider, useGraph } from './graph-provider.tsx'

/**
 * The graph session, its boot flows and the mobile onboarding are covered in
 * `@reflect/core` and `@reflect/app`.
 * These cover the provider as their React shell. They mount it themselves:
 * `renderInApp` reports a graph over the session, which hides the opens.
 */

/**
 * The fixed mobile roots the test storage reports.
 */
const MOBILE_ROOT = '/Documents'
const ICLOUD_ROOT = '/iCloud/Documents'

function tree(children: ReactNode, platform?: AppPlatform): ReactElement {
  return <GraphProvider {...(platform === undefined ? {} : { platform })}>{children}</GraphProvider>
}

/**
 * Mount the provider over `core` and read its context.
 */
async function renderGraph<Core extends CoreServices>(
  core: Core,
  platform?: AppPlatform,
  appServices?: Partial<AppServices>,
) {
  const result = {} as { current: ReturnType<typeof useGraph> }
  function Probe(): null {
    result.current = useGraph()
    return null
  }
  const view = await renderInApp(tree(<Probe />, platform), {
    core,
    servicesOnly: true,
    ...(appServices === undefined ? {} : { appServices }),
  })
  return {
    core,
    appServices: view.appServices,
    result,
  }
}

/**
 * A graph session whose `graph_open` reports `problems` for the graph at
 * `/notes` and none for any other root.
 */
function graphSessionReporting(problems: {
  localOnlyWarnings?: string[]
  backupWarnings?: string[]
}) {
  let generation = 0
  return createTestGraphSessionService({
    ipc: createTestIpcBridgeService({
      commands: {
        recent_graphs: () => [],
        graph_open: (args) => {
          const root = String(args['path'])
          generation += 1
          return {
            root,
            name: root.slice(1),
            generation,
            localOnlyFolders: [],
            ...(root === '/notes' ? problems : {}),
          }
        },
      },
    }),
  })
}

describe('GraphProvider', () => {
  it('starts at the chooser when there are no recents', async () => {
    const { result } = await renderGraph(
      createTestCoreServices({ database: createWasmTestDatabaseService() }),
    )
    await vi.waitFor(() => expect(result.current.status).toBe('choosing'))
    expect(result.current.graph).toBeNull()
  })

  it('returns to the graph chooser without opening the folder picker', async () => {
    const recents: RecentGraph[] = [{ root: '/known', name: 'known', openedMs: 1 }]
    const dialog = createTestDialogService()
    const { result } = await renderGraph(
      createTestCoreServices({
        database: createWasmTestDatabaseService(),
        graphSession: createTestGraphSessionService({ recents }),
      }),
      undefined,
      { dialog },
    )
    await vi.waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.graph?.root).toBe('/known')

    await act(async () => {
      await result.current.chooseGraph()
    })

    expect(result.current.status).toBe('choosing')
    expect(result.current.graph).toBeNull()
    expect(result.current.indexGeneration).toBeNull()
    expect(dialog.calls()).toEqual([])
    expect(result.current.recents).toEqual(recents)
  })

  it('opens a picked folder and seeds the empty graph', async () => {
    const { core, appServices, result } = await renderGraph(
      createTestCoreServices({ database: createWasmTestDatabaseService() }),
    )
    appServices.dialog.setFolder('/fresh')
    await vi.waitFor(() => expect(result.current.status).toBe('choosing'))

    await act(async () => {
      await result.current.pickAndOpen()
    })

    expect(result.current.status).toBe('ready')
    expect(result.current.graph?.root).toBe('/fresh')
    // The welcome note is written, and the graph is marked as seeded.
    expect(core.noteFile.writes()).toHaveLength(1)
    await expect(core.indexStore.getMeta('welcomeSeeded')).resolves.toBe('true')
  })

  it('boots the app’s graph session and passes its actions through', async () => {
    const { core, result } = await renderGraph(
      createTestCoreServices({ database: createWasmTestDatabaseService() }),
    )
    await vi.waitFor(() => expect(result.current.status).toBe('choosing'))

    await act(async () => {
      await result.current.openRecent('/a')
    })

    expect(result.current.status).toBe('ready')
    expect(result.current.graph).toEqual({
      root: '/a',
      name: 'a',
      generation: 1,
      localOnlyFolders: [],
      localOnlyEditableFolders: [],
    })
    expect(result.current.indexGeneration).toBe(1)
    expect(core.graphSession.getState().graph?.root).toBe('/a')
  })

  it('provides the open session’s graph services', async () => {
    function SessionRoot() {
      const { session, role } = useGraphServices()
      return (
        <p>
          {role} {session.root}
        </p>
      )
    }
    function Probe() {
      const { status, openRecent } = useGraph()
      if (status === 'ready') {
        return <SessionRoot />
      }
      return (
        <button
          type="button"
          disabled={status !== 'choosing'}
          onClick={() => void openRecent('/a')}
        >
          Open
        </button>
      )
    }
    const core = createTestCoreServices({ database: createWasmTestDatabaseService() })
    const screen = await renderInApp(tree(<Probe />), { core, servicesOnly: true })

    await screen.getByRole('button', { name: 'Open' }).click()

    await expect.element(screen.getByText('main /a')).toBeVisible()
    expect(core.graphSession.getState().session?.signal.aborted).toBe(false)
  })

  it('shows a graph’s local-only configuration problems when it opens', async () => {
    const warning = '"ſecure" can’t be a local-only folder (it must be plain ASCII).'
    const app = createTestCoreServices({
      database: createWasmTestDatabaseService(),
      graphSession: graphSessionReporting({ localOnlyWarnings: [warning] }),
    })
    onTestFinished(() => app.database.close())
    const { appServices, result } = await renderGraph(app)
    const localOnlyOperations = () => {
      return appServices.operations
        .getAll()
        .filter((operation) => operation.label === 'Local-only folders')
    }
    await vi.waitFor(() => expect(result.current.status).toBe('choosing'))

    // Control: a clean configuration shows nothing.
    await act(async () => {
      await result.current.openRecent('/clean')
    })
    expect(result.current.status).toBe('ready')
    expect(localOnlyOperations()).toEqual([])

    await act(async () => {
      await result.current.openRecent('/notes')
    })
    await vi.waitFor(() => expect(localOnlyOperations()).toHaveLength(1))
    expect(localOnlyOperations()[0]).toMatchObject({
      status: 'warning',
      persistent: true,
      message: warning,
    })
  })

  it('shows a graph’s backup settings problems when it opens', async () => {
    const warning = 'The backup size limit for this graph must be a whole number of MiB.'
    const app = createTestCoreServices({
      database: createWasmTestDatabaseService(),
      graphSession: graphSessionReporting({ backupWarnings: [warning] }),
    })
    onTestFinished(() => app.database.close())
    const { appServices, result } = await renderGraph(app)
    const backupOperations = () => {
      return appServices.operations
        .getAll()
        .filter((operation) => operation.label === 'Backup settings')
    }
    await vi.waitFor(() => expect(result.current.status).toBe('choosing'))

    await act(async () => {
      await result.current.openRecent('/clean')
    })
    expect(result.current.status).toBe('ready')
    expect(backupOperations()).toEqual([])

    await act(async () => {
      await result.current.openRecent('/notes')
    })
    await vi.waitFor(() => expect(backupOperations()).toHaveLength(1))
    expect(backupOperations()[0]).toMatchObject({
      status: 'warning',
      persistent: true,
      message: warning,
    })
  })
})

describe('GraphProvider mobile onboarding (Plans 19/21)', () => {
  it('boots the app’s mobile onboarding and opens no graph before a choice', async () => {
    const storage = {
      localRoot: MOBILE_ROOT,
      icloudDocumentsRoot: ICLOUD_ROOT,
      icloudGraphRoots: [],
    }
    const { core, result } = await renderGraph(
      createTestCoreServices({
        database: createWasmTestDatabaseService(),
        platform: createTestPlatformService({ appPlatform: 'ios' }),
        mobileStorage: createTestMobileStorageService({ storage }),
      }),
      'ios',
    )

    await vi.waitFor(() => expect(result.current.needsOnboarding).toBe(true))
    expect(result.current.status).toBe('choosing')
    expect(result.current.graph).toBeNull()
    await vi.waitFor(() => expect(result.current.mobileStorageInfo).toEqual(storage))
    expect(result.current.mobileStorageResolving).toBe(false)
    expect(core.graphSession.getState().graph).toBeNull()
  })

  it('publishes the app’s mobile onboarding and passes completeOnboarding through', async () => {
    const { core, appServices, result } = await renderGraph(
      createTestCoreServices({
        database: createWasmTestDatabaseService(),
        platform: createTestPlatformService({ appPlatform: 'ios' }),
      }),
      'ios',
    )
    await vi.waitFor(() => expect(result.current.needsOnboarding).toBe(true))
    await vi.waitFor(() => expect(result.current.mobileStorageResolving).toBe(false))

    await act(async () => {
      await result.current.completeOnboarding('local')
    })

    expect(result.current.status).toBe('ready')
    expect(result.current.needsOnboarding).toBe(false)
    expect(result.current.graph?.root).toBe('/local/Documents')
    expect(result.current.mobileStorageKind).toBe('local')
    expect(appServices.mobileOnboarding.getState().kind).toBe('local')
    await vi.waitFor(() => expect(core.settings.saves().at(-1)?.mobileOnboarded).toBe(true))
  })
})
