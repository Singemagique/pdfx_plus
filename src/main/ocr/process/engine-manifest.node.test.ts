// Packaging guards for the OCR engine (DESIGN.md §3.2.1, §3.2.4, §3.2.8): every electron-builder
// `extraResources` source exists and, for the engine, has exactly the manifest's bytes; only the
// simd-lstm core and the four 4.0.0_best_int languages are copied (nothing from the packages enters
// the asar); every licence notice listed for the linked libraries is shipped; and the package.json
// pins match.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { BUNDLED_LANGS, ENGINE_CORE, ENGINE_DATA, RESOURCES_OCR_DIR } from './engine-manifest'

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const sha = (p: string): string =>
  createHash('sha256')
    .update(readFileSync(join(ROOT, p)))
    .digest('hex')

interface ExtraResource {
  from: string
  to: string
  filter?: string[]
}

/** The `extraResources` list of electron-builder.yml (a small, exact parser for this file's shape). */
function extraResources(): ExtraResource[] {
  const lines = readFileSync(join(ROOT, 'electron-builder.yml'), 'utf8').split(/\r?\n/)
  const start = lines.indexOf('extraResources:')
  expect(start).toBeGreaterThanOrEqual(0)
  const out: ExtraResource[] = []
  let cur: ExtraResource | null = null
  let inFilter = false
  for (const raw of lines.slice(start + 1)) {
    if (/^\S/.test(raw)) break // the next top-level key
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    let m: RegExpExecArray | null
    if ((m = /^- from: (.+)$/.exec(line))) {
      cur = { from: m[1], to: '' }
      out.push(cur)
      inFilter = false
    } else if ((m = /^to: (.+)$/.exec(line)) && cur) cur.to = m[1]
    else if (line === 'filter:' && cur) {
      cur.filter = []
      inFilter = true
    } else if ((m = /^- '(.+)'$/.exec(line)) && cur && inFilter) cur.filter!.push(m[1])
    else throw new Error(`unexpected extraResources line: ${line}`)
  }
  return out
}

/** Every notice §3.2.8 requires for tesseract-core-simd-lstm.wasm and the bundled data. */
const OCR_LICENCE_FILES = [
  'tesseract.js-core-LICENSE.txt',
  'Tesseract-LICENSE.txt',
  'Leptonica-LICENSE.txt',
  'libjpeg-LICENSE.txt',
  'libpng-LICENSE.txt',
  'libtiff-LICENSE.txt',
  'libwebp-LICENSE.txt',
  'libwebp-PATENTS.txt',
  'giflib-LICENSE.txt',
  'zlib-LICENSE.txt',
  'openlibm-LICENSE.txt',
  'Emscripten-LICENSE.txt',
  'musl-LICENSE.txt',
  'libcxx-LICENSE.txt',
  'libcxxabi-LICENSE.txt',
  'compiler-rt-LICENSE.txt',
  'tessdata-LICENSE.txt',
  'tesseract.js-data-LICENSE.txt',
  'THIRD_PARTY_NOTICES.md'
]

describe('OCR packaging', () => {
  const res = extraResources()

  it('every extraResources source exists', () => {
    for (const r of res) expect(existsSync(join(ROOT, r.from)), r.from).toBe(true)
  })

  it('copies exactly the manifest files to resources/ocr, each with the manifest SHA-256', () => {
    const ocr = res.filter(
      (r) => r.to === RESOURCES_OCR_DIR || r.to.startsWith(`${RESOURCES_OCR_DIR}/`)
    )
    const want = [
      { from: ENGINE_CORE.js.source, to: `ocr/${ENGINE_CORE.js.file}` },
      { from: ENGINE_CORE.wasm.source, to: `ocr/${ENGINE_CORE.wasm.file}` },
      ...BUNDLED_LANGS.map((l) => ({
        from: ENGINE_DATA[l].source,
        to: `ocr/tessdata/${ENGINE_DATA[l].file}`
      }))
    ]
    expect(ocr).toEqual(want)
    for (const f of [ENGINE_CORE.js, ENGINE_CORE.wasm, ...Object.values(ENGINE_DATA)]) {
      expect(statSync(join(ROOT, f.source)).size, f.source).toBe(f.bytes)
      expect(sha(f.source), f.source).toBe(f.sha256)
    }
    // best_int only: never the 4.0.0 (legacy + LSTM) folder, never another core build.
    for (const r of ocr) {
      expect(r.from).not.toMatch(/\/4\.0\.0\//)
      expect(r.from).not.toMatch(/relaxedsimd|core-lstm|\.wasm\.js$/)
    }
  })

  it('the design pins (§3.2.1) are the manifest', () => {
    expect(ENGINE_CORE.wasm.sha256).toBe(
      '34e8d50cac216427d86bf397d610fdd9f49492539bbcdfbfccc4eda20c810bea'
    )
    expect(ENGINE_CORE.js.sha256).toBe(
      'e48e2f02ddae3716c8dd24bf41cd290d4efa96892d689cdc4013c2545d63f469'
    )
    expect(ENGINE_CORE.wasm.bytes + ENGINE_CORE.js.bytes).toBe(2_946_872)
    expect(BUNDLED_LANGS).toEqual(['eng', 'deu', 'fra', 'spa'])
    expect(Object.values(ENGINE_DATA).reduce((n, d) => n + d.bytes, 0)).toBe(7_093_571)
  })

  it('ships every licence notice for the linked libraries and the data', () => {
    const shipped = new Set<string>()
    for (const r of res) {
      if (!r.to.startsWith('licenses')) continue
      if (r.filter) {
        // A directory copy: every listed file in it that matches the filter.
        for (const f of OCR_LICENCE_FILES)
          if (
            existsSync(join(ROOT, r.from, f)) &&
            r.filter.some((g) => f.endsWith(g.replace('*', '')))
          )
            shipped.add(f)
      } else shipped.add(r.to.slice('licenses/'.length))
    }
    for (const f of OCR_LICENCE_FILES) expect(shipped.has(f), f).toBe(true)
    // Each is a real licence text, not an error page.
    for (const f of OCR_LICENCE_FILES) {
      const src = res.find((r) => r.to === `licenses/${f}`)?.from ?? join('build/licenses', f)
      const text = readFileSync(join(ROOT, src), 'utf8')
      expect(text.length, f).toBeGreaterThan(500)
      expect(text, f).not.toMatch(/<!DOCTYPE html|404: Not Found/i)
    }
  })

  it('keeps the packages and the notices out of the asar (devDependencies + files exclusions)', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
      devDependencies: Record<string, string>
      resolutions?: Record<string, string>
    }
    expect(pkg.devDependencies['tesseract.js-core']).toBe('7.0.0')
    expect(pkg.resolutions?.['tesseract.js-core']).toBe('7.0.0')
    for (const l of BUNDLED_LANGS)
      expect(pkg.devDependencies[`@tesseract.js-data/${l}`]).toBe('1.0.0')
    expect(Object.keys(pkg.dependencies).filter((d) => /tesseract/.test(d))).toEqual([])
    const yml = readFileSync(join(ROOT, 'electron-builder.yml'), 'utf8')
    expect(yml).toContain("'!{THIRD_PARTY_NOTICES.md,build/licenses/**,bench/**,types/**}'")
  })

  it('keeps every tsconfig*.json out of the asar (one glob, so a new project file cannot slip in)', () => {
    const yml = readFileSync(join(ROOT, 'electron-builder.yml'), 'utf8')
    expect(yml).toContain("- '!tsconfig*.json'")
    const tsconfigs = readdirSync(ROOT).filter((f) => /^tsconfig.*\.json$/.test(f))
    expect(tsconfigs).toEqual(expect.arrayContaining(['tsconfig.json', 'tsconfig.shared.json']))
  })
})
