import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'core-node',
    environment: 'node',
    fsModuleCache: true,
    isolate: false,
    include: ['src/**/*.test.ts'],
    setupFiles: ['./vitest.setup.ts'],
    restoreMocks: true,
    sequence: { groupOrder: 200 },
    retry: process.env.CI ? 3 : 0,
    benchmark: {
      include: ['src/bench/**/*.bench.ts'],
      // The parse and projection benchmarks run core's own cross-module calls,
      // which go through the module runner's export getters on every run alike.
      // Left on, the warning fails each benchmark under the fail-on-console setup.
      suppressExportGetterWarnings: true,
    },
  },
})
