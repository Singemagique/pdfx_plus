import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// Resolve renderer imports the same way electron.vite.config.ts does, so tests can
// import renderer modules via '@renderer/...' as well as relative paths.
const alias = {
  '@renderer': resolve(__dirname, 'src/renderer/src')
}

export default defineConfig({
  resolve: { alias },
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      // .tsx too: components are most of the renderer, and excluding them made the headline
      // number describe only the non-component half of the codebase.
      include: ['src/**/*.{ts,tsx}'],
      // test-utils/ holds fixtures shared between suites — test code, not production source.
      exclude: ['src/**/*.d.ts', 'src/**/*.test.ts', 'src/**/*.test.tsx', '**/test-utils/**']
    },
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'node',
          environment: 'node',
          include: ['src/**/*.node.test.ts']
        }
      },
      {
        resolve: { alias },
        test: {
          name: 'jsdom',
          environment: 'jsdom',
          include: ['src/**/*.dom.test.ts']
        }
      }
    ]
  }
})
