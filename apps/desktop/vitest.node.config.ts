import { defineDesktopProject } from './vitest.shared.ts'

export default defineDesktopProject({
  test: {
    name: 'node',
    environment: 'node',
    fsModuleCache: true,
    isolate: false,
    include: ['src/**/*.test.ts'],
    sequence: { groupOrder: 200 },
  },
})
