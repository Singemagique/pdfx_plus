// Test-only: bundle an OCR process or thread entry (TypeScript) into one CommonJS file, the way
// electron-vite's `?modulePath` does for the app, so a test can run the REAL entry in a real
// worker_thread or child process. vitest's own transform only applies inside the test realm; a
// `new Worker(file)` needs plain JS on disk.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

export interface Bundled {
  file: string
  dispose(): void
}

export interface BundleOptions {
  /** Module specifier → absolute file path to bundle in its place (e.g. a fake `electron`). */
  alias?: Record<string, string>
  /** Packages to leave as runtime requires. */
  external?: string[]
  /** Output format; `esm` keeps `import { x } from 'node:…'` as real ESM bindings. */
  format?: 'cjs' | 'esm'
}

/** Bundle `entry` (absolute path) to `<tmp>/entry.cjs` (or `.mjs`). */
export async function bundleEntry(entry: string, opts: BundleOptions = {}): Promise<Bundled> {
  const dir = mkdtempSync(join(tmpdir(), 'pdfx-ocr-bundle-'))
  const format = opts.format ?? 'cjs'
  const file = join(dir, format === 'esm' ? 'entry.mjs' : 'entry.cjs')
  await build({
    entryPoints: [entry],
    outfile: file,
    bundle: true,
    platform: 'node',
    format,
    target: 'node22',
    logLevel: 'silent',
    alias: opts.alias,
    external: opts.external ?? ['electron']
  })
  return {
    file,
    dispose: () => rmSync(dir, { recursive: true, force: true })
  }
}
