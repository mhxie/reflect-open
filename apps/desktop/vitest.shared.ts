import { fileURLToPath } from 'node:url'
import { defineProject, type ViteUserConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export function defineDesktopProject(project: {
  plugins?: ViteUserConfig['plugins']
  test: NonNullable<ViteUserConfig['test']>
}): ViteUserConfig {
  return defineProject({
    plugins: [react({ compiler: true }), ...(project.plugins ?? [])],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    // A dependency that Vite first sees in the middle of a browser run gets
    // optimized on the spot and reloads the page, which kills the test file
    // in flight. Only a few test files reach these, so name them up front.
    optimizeDeps: {
      include: [
        '@tauri-apps/api/core',
        // The fork's sheets, selects, switches and drag-to-reorder lists.
        '@base-ui/react/drawer',
        '@base-ui/react/merge-props',
        '@base-ui/react/select',
        '@base-ui/react/switch',
        '@base-ui/react/use-render',
        '@dnd-kit/core',
        '@dnd-kit/sortable',
        '@dnd-kit/utilities',
        '@shadcn/react/message-scroller',
        // Seen late on a cold cache, reloading the page mid-run.
        '@base-ui/react/checkbox',
        '@base-ui/react/dialog',
        '@base-ui/react/menu',
        '@base-ui/react/toast',
        '@prosekit/pm/history',
        '@prosekit/pm/model',
        '@prosekit/pm/transform',
        '@prosekit/pm/view',
        'cmdk',
        'embla-carousel-react',
        'react-dom/client',
        'react-error-boundary',
        'virtua',
      ],
    },
    test: {
      globals: false,
      restoreMocks: true,
      retry: process.env.CI ? 3 : 0,
      setupFiles: ['./src/test-utils/setup-console.ts'],
      slowTestThreshold: 10_000,
      ...project.test,
    },
  })
}
