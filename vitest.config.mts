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
          // Covers src/shared/**/*.node.test.ts too (the DOM-free modules shared by every process).
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
      },
      {
        resolve: { alias },
        test: {
          // Tier 1 (DESIGN.md §3.9.3): the REAL Tesseract core and data from node_modules (the
          // bytes resources/ocr ships, SHA-checked) on the synth presets, gated against
          // bench/ocr-baseline.json. One file at a time: each runs real recognize threads.
          name: 'ocr',
          environment: 'node',
          include: ['src/**/*.ocr.test.ts'],
          testTimeout: 120_000,
          hookTimeout: 120_000,
          fileParallelism: false
        }
      }
    ]
  }
})
