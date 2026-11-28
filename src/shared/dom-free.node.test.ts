// `src/shared/**` must run unchanged in the renderer, the main process, a utilityProcess, a
// worker_thread and plain vitest Node, so it may not touch DOM globals or import Electron or
// DOM-only packages (DESIGN.md §3.3.1). OCR code under src/shared/ocr also may not reach the
// network (§3.9.3, privacy layer 1). There is no ESLint in this repo; these tests are the rules.

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  NETWORK_GLOBALS,
  NETWORK_MODULES,
  scanSource,
  type ScanFinding
} from './test-utils/source-scan'

const SHARED_DIR = fileURLToPath(new URL('.', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(p))
    // JS too: a .js/.mjs/.cjs file is neither typechecked (allowJs is off) nor exempt.
    else if (SOURCE_FILE.test(entry.name)) out.push(p)
  }
  return out
}

const SOURCE_FILE = /\.[cm]?[jt]sx?$/

const names = (src: string, filePath?: string): string[] =>
  scanSource(src, { filePath }).map((f: ScanFinding) => `${f.kind}:${f.name}`)

describe('src/shared is DOM-free and Electron-free', () => {
  it('has no banned globals or imports in any file', () => {
    const files = sourceFiles(SHARED_DIR)
    expect(files.length).toBeGreaterThan(3)
    const problems: string[] = []
    for (const file of files) {
      const rel = relative(REPO_ROOT, file).replace(/\\/g, '/')
      for (const f of scanSource(readFileSync(file, 'utf8'), { filePath: rel }))
        problems.push(`${rel}:${f.line}:${f.column} ${f.kind} ${f.name}`)
    }
    expect(problems).toEqual([])
  })

  it('src/shared/ocr imports no network module and reads no network global', () => {
    const files = sourceFiles(join(SHARED_DIR, 'ocr'))
    expect(files.length).toBeGreaterThan(3)
    const problems: string[] = []
    for (const file of files) {
      const rel = relative(REPO_ROOT, file).replace(/\\/g, '/')
      const findings = scanSource(readFileSync(file, 'utf8'), {
        filePath: rel,
        globals: NETWORK_GLOBALS,
        modules: NETWORK_MODULES,
        forbiddenDirs: []
      })
      for (const f of findings) problems.push(`${rel}:${f.line}:${f.column} ${f.kind} ${f.name}`)
    }
    expect(problems).toEqual([])
  })
})

describe('scanSource', () => {
  const net = (src: string): string[] =>
    scanSource(src, { globals: NETWORK_GLOBALS, modules: NETWORK_MODULES }).map((f) => f.name)

  it('scans every JS/TS extension, JS parsed as JS', () => {
    for (const f of ['a.ts', 'a.tsx', 'a.mts', 'a.cts', 'a.js', 'a.jsx', 'a.mjs', 'a.cjs'])
      expect(SOURCE_FILE.test(f), f).toBe(true)
    expect(SOURCE_FILE.test('a.json')).toBe(false)
    expect(SOURCE_FILE.test('a.d.ts')).toBe(true)
    expect(names("const e = require('electron')", 'src/shared/ocr/foo.mjs')).toEqual([
      'import:electron'
    ])
    expect(names('const t = <div>{document.title}</div>', 'src/shared/x.jsx')).toEqual([
      'global:document'
    ])
  })

  it('applies the network rule set when asked', () => {
    expect(net("import https from 'node:https'")).toEqual(['node:https'])
    expect(net("import { lookup } from 'dns/promises'")).toEqual(['dns/promises'])
    expect(net("const { request } = require('undici')")).toEqual(['undici'])
    expect(net('await fetch(url)')).toEqual(['fetch'])
    expect(net('new WebSocket(u)')).toEqual(['WebSocket'])
    expect(net("import { readFileSync } from 'node:fs'; const s = 'fetch'")).toEqual([])
    expect(net("eval('1')")).toEqual(['eval'])
    expect(net("new Function('return 1')")).toEqual(['Function'])
    expect(net('type F = Function')).toEqual([])
  })

  it('sees network globals behind globalThis wrappers, global and destructuring', () => {
    expect(net('(globalThis as any).fetch(u)')).toEqual(['globalThis.fetch'])
    expect(net('(<any>globalThis).fetch(u)')).toEqual(['globalThis.fetch'])
    expect(net('globalThis!.fetch(u)')).toEqual(['globalThis.fetch'])
    expect(net('(globalThis satisfies object as any).fetch(u)')).toEqual(['globalThis.fetch'])
    expect(net('global.fetch(u)')).toEqual(['globalThis.fetch'])
    expect(net("global['fetch'](u)")).toEqual(['globalThis.fetch'])
    expect(net('globalThis.globalThis.fetch(u)')).toEqual(['globalThis.fetch'])
    expect(net('global.globalThis.fetch(u)')).toEqual(['globalThis.fetch'])
    expect(net('const { fetch: f } = globalThis; f(u)')).toEqual(['globalThis.fetch'])
    expect(net("const { 'fetch': f } = global")).toEqual(['globalThis.fetch'])
    expect(net('let f; ({ fetch: f } = globalThis)')).toEqual(['globalThis.fetch'])
    expect(net('const { fetch } = globalThis')).toEqual(['fetch'])
    expect(net('globalThis.process.env.X')).toEqual([])
  })

  it('reports the global object behind a computed key or an alias', () => {
    expect(net("globalThis['fe' + 'tch'](u)")).toEqual(['globalThis[?]'])
    expect(net('const g = globalThis; g.fetch(u)')).toEqual(['globalThis (aliased)'])
    expect(net("Reflect.get(global, 'fetch')")).toEqual(['global (aliased)'])
    expect(net('const { ...all } = globalThis')).toEqual(['globalThis{…}'])
    expect(net('if (typeof globalThis === "object") {}')).toEqual([])
    expect(net('declare global { interface X { a: 1 } }')).toEqual([])
    expect(net('const o = { global: 1 }; o.global')).toEqual([])
  })

  it('reports value references to banned globals', () => {
    expect(names('window.addEventListener("x", f)')).toEqual(['global:window'])
    expect(names('const t = document.title')).toEqual(['global:document'])
    expect(names('self.postMessage(1)')).toEqual(['global:self'])
    expect(names('const ua = navigator.userAgent')).toEqual(['global:navigator'])
    expect(names('if (typeof window !== "undefined") {}')).toEqual(['global:window'])
    expect(names('f(window)')).toEqual(['global:window'])
    expect(names('const o = { window }')).toEqual(['global:window'])
    expect(names('const x = `${document.title}`')).toEqual(['global:document'])
    expect(names('let d: typeof document')).toEqual(['global:document'])
  })

  it('reports more browser-only globals than the four DOM roots', () => {
    const src = [
      'localStorage.getItem("a")',
      'requestAnimationFrame(f)',
      'new OffscreenCanvas(1, 1)',
      'new Image()',
      'const h = location.href',
      'addEventListener("message", f)',
      'postMessage(1)',
      'new DOMParser()'
    ].join('\n')
    expect(names(src).map((n) => n.replace('global:', ''))).toEqual([
      'localStorage',
      'requestAnimationFrame',
      'OffscreenCanvas',
      'Image',
      'location',
      'addEventListener',
      'postMessage',
      'DOMParser'
    ])
    // Node-safe relatives stay allowed.
    expect(names('new TextDecoder(); structuredClone(x); queueMicrotask(f); new URL(u)')).toEqual(
      []
    )
  })

  it('reports globalThis property access by name', () => {
    expect(names('globalThis.window.close()')).toEqual(['global:globalThis.window'])
    expect(names("globalThis['navigator']")).toEqual(['global:globalThis.navigator'])
    expect(names('globalThis.process')).toEqual([])
    expect(names('(globalThis as any).window.foo')).toEqual(['global:globalThis.window'])
    expect(names('(globalThis).document.title')).toEqual(['global:globalThis.document'])
    expect(names('globalThis!.document')).toEqual(['global:globalThis.document'])
    expect(names('const { window: w } = globalThis')).toEqual(['global:globalThis.window'])
    expect(names('global.window')).toEqual(['global:globalThis.window'])
    expect(names("globalThis['win' + 'dow']")).toEqual(['global:globalThis[?]'])
  })

  it('reports shadowing locals (stricter than no-restricted-globals; rename them)', () => {
    expect(names('const self = this')).toEqual(['global:self'])
    expect(names('function f(document: string) { return document }')).toEqual([
      'global:document',
      'global:document'
    ])
  })

  it('ignores comments, strings, templates text and regex literals', () => {
    const src = [
      '// window.open() in a comment',
      '/* document.body\n navigator */',
      '/** @see self */',
      'const a = "window.document"',
      "const b = 'self navigator'",
      'const c = `window ${1 + 2} document`',
      'const d = /window|document/g',
      'const e = String.raw`self`'
    ].join('\n')
    expect(names(src)).toEqual([])
  })

  it('ignores property names, member declarations and type names', () => {
    const src = [
      'const o = { window: 1, document() {}, get self() { return 1 } }',
      'o.window = o.document',
      'const { window: w } = o',
      'class K { navigator = 1; self(): void {} }',
      'interface I { window: number; document(): void }',
      'type T = { self: string }',
      'enum E { window }',
      'let x: window.Foo',
      'outer: for (;;) { break outer }'
    ].join('\n')
    expect(names(src)).toEqual([])
  })

  it('reports banned module imports in every import form', () => {
    expect(names("import { app } from 'electron'")).toEqual(['import:electron'])
    expect(names("import type { App } from 'electron'")).toEqual(['import:electron'])
    expect(names("export * from 'electron/main'")).toEqual(['import:electron/main'])
    expect(names("import x = require('react')")).toEqual(['import:react'])
    expect(names("const e = require('electron')")).toEqual(['import:electron'])
    expect(names("const m = await import('react-dom/client')")).toEqual(['import:react-dom/client'])
    expect(names("type A = import('electron').App")).toEqual(['import:electron'])
    expect(names("import { is } from '@electron-toolkit/utils'")).toEqual([
      'import:@electron-toolkit/utils'
    ])
    expect(names("import u from 'x/font.ttf?url'")).toEqual(['import:x/font.ttf?url'])
    expect(names("import { a } from '@renderer/pdfx/fonts'")).toEqual([
      'import:@renderer/pdfx/fonts'
    ])
  })

  it('reports require/import() with a non-literal argument', () => {
    expect(names('const m = require(name)')).toEqual(['dynamic-import:require()'])
    expect(names('await import(`./${x}`)')).toEqual(['dynamic-import:import()'])
  })

  it('treats every require-like call as an import', () => {
    expect(names("module.require('electron')")).toEqual(['import:electron'])
    expect(names("process.mainModule?.require('electron')")).toEqual(['import:electron'])
    expect(names("process.getBuiltinModule('electron')")).toEqual(['import:electron'])
    expect(names("(0, require)('electron')")).toEqual(['import:electron'])
    expect(names("require?.('electron')")).toEqual(['import:electron'])
    expect(names("(require as any)('electron')")).toEqual(['import:electron'])
    expect(names("module['require']('electron')")).toEqual(['import:electron'])
    expect(names("createRequire(import.meta.url)('electron')")).toEqual(['import:electron'])
    expect(names("import { createRequire } from 'node:module'")).toEqual(['import:node:module'])
    expect(names("import m from 'module'")).toEqual(['import:module'])
    expect(net("process.getBuiltinModule('node:https')")).toEqual(['node:https'])
    expect(net("module.require('http')")).toEqual(['http'])
  })

  it('reports a loader that is handed on instead of called', () => {
    expect(names("const r = require; r('electron')")).toEqual(['dynamic-import:require (aliased)'])
    expect(names("require.call(null, 'electron')")).toEqual(['dynamic-import:require (aliased)'])
    expect(names('const r = module.require')).toEqual(['dynamic-import:.require (aliased)'])
    expect(names("const req = createRequire(import.meta.url); req('electron')")).toEqual([
      'dynamic-import:createRequire (aliased)'
    ])
    expect(names('const cr = createRequire')).toEqual(['dynamic-import:createRequire (aliased)'])
    expect(names('f(process.getBuiltinModule)')).toEqual([
      'dynamic-import:.getBuiltinModule (aliased)'
    ])
    // Not loading anything: allowed.
    expect(names("if (typeof require === 'function') {}")).toEqual([])
    expect(names("const p = require.resolve('pdf-lib')")).toEqual([])
    expect(names('declare const require: unknown')).toEqual([])
  })

  it('allows environment-agnostic packages and node built-ins', () => {
    const src = [
      "import { PDFDocument } from 'pdf-lib'",
      "import { zlibSync } from 'fflate'",
      "import { createHash } from 'node:crypto'",
      "import { init } from '@embedpdf/pdfium'",
      "import { a } from './electron-free'",
      "const s = 'electron'"
    ].join('\n')
    expect(names(src)).toEqual([])
  })

  it('reports relative imports that reach into renderer, main or preload', () => {
    const file = 'src/shared/ocr/x.ts'
    expect(names("import { f } from '../../renderer/src/pdfx/fonts'", file)).toEqual([
      'import:../../renderer/src/pdfx/fonts'
    ])
    expect(names("import { g } from '../../main/index'", file)).toEqual(['import:../../main/index'])
    expect(names("import { h } from '../types'", file)).toEqual([])
  })

  it('gives 1-based positions', () => {
    expect(scanSource('const a = 1\n  window.x')).toEqual([
      { line: 2, column: 3, kind: 'global', name: 'window' }
    ])
  })
})
