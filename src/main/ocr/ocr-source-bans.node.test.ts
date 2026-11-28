// Privacy layer 1 for the OCR utility process (DESIGN.md §3.9.3): a static source scan of
// src/main/ocr/process/** (the repo has no ESLint; this test is the rule). Everything that runs in
// the "pdfx-ocr" process or its threads must not import Electron or any network module, must not
// read a network global (`fetch` needs no import), and must not load a module by a computed name.
// The tripwire, no-network.ts, is the one file allowed to name those APIs: it is what replaces
// them. src/shared/ocr/** gets the same network rules from src/shared/dom-free.node.test.ts.

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import {
  NETWORK_GLOBALS,
  NETWORK_MODULES,
  scanSource,
  type ScanOptions
} from '../../shared/test-utils/source-scan'

const PROCESS_DIR = fileURLToPath(new URL('./process', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const TRIPWIRE = 'src/main/ocr/process/no-network.ts'
const ENTRIES = [
  'src/main/ocr/process/index.ts',
  'src/main/ocr/process/raster-thread.ts',
  'src/main/ocr/process/recognize-thread.ts'
]

/** Modules the OCR process may never load: Electron, the network, and process/inspector escapes. */
const OCR_PROCESS_BANNED_MODULES = [
  'electron',
  'electron/*',
  '@electron-toolkit/*',
  ...NETWORK_MODULES,
  ...['child_process', 'cluster', 'inspector', 'repl'].flatMap((m) => [
    m,
    `${m}/*`,
    `node:${m}`,
    `node:${m}/*`
  ])
]

const RULES: ScanOptions = {
  globals: NETWORK_GLOBALS,
  modules: OCR_PROCESS_BANNED_MODULES,
  forbiddenDirs: ['src/renderer', 'src/preload'],
  // The process and thread entries are separate bundles, linked by electron-vite's ?modulePath.
  allowedQueries: ['modulePath']
}

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...sourceFiles(p))
    // Tests run in vitest, never in the utility process.
    else if (/\.[cm]?[jt]sx?$/.test(e.name) && !/\.test\.[cm]?[jt]sx?$/.test(e.name)) out.push(p)
  }
  return out
}

const rel = (abs: string): string => relative(REPO_ROOT, abs).replace(/\\/g, '/')

/** Every module specifier a file names statically (imports, re-exports, literal require/import()). */
function specifiers(source: string, file: string): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const out: string[] = []
  const visit = (n: ts.Node): void => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier)
      out.push((n.moduleSpecifier as ts.StringLiteral).text)
    else if (ts.isCallExpression(n) && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0])) {
      const callee = n.expression
      if (
        callee.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(callee) && callee.text === 'require')
      )
        out.push(n.arguments[0].text)
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}

describe('src/main/ocr/process/** source bans', () => {
  const files = sourceFiles(PROCESS_DIR)

  it('covers the process and thread entries', () => {
    const names = files.map(rel)
    for (const e of [...ENTRIES, TRIPWIRE]) expect(names).toContain(e)
  })

  it('imports no electron or network module and reads no network global (tripwire excepted)', () => {
    const problems: string[] = []
    for (const file of files) {
      const r = rel(file)
      if (r === TRIPWIRE) continue
      for (const f of scanSource(readFileSync(file, 'utf8'), { ...RULES, filePath: r }))
        problems.push(`${r}:${f.line}:${f.column} ${f.kind} ${f.name}`)
    }
    expect(problems).toEqual([])
  })

  it('loads nothing by a computed name, the tripwire included', () => {
    const problems: string[] = []
    for (const file of files) {
      const r = rel(file)
      const findings = scanSource(readFileSync(file, 'utf8'), {
        globals: [],
        modules: [],
        forbiddenDirs: [],
        allowedQueries: ['modulePath'],
        filePath: r
      }).filter((f) => f.kind === 'dynamic-import')
      for (const f of findings) problems.push(`${r}:${f.line}:${f.column} ${f.name}`)
    }
    expect(problems).toEqual([])
  })

  it('stays inside its own folder and src/shared (no path back into main, preload or renderer)', () => {
    const allowed = [resolve(PROCESS_DIR), resolve(REPO_ROOT, 'src/shared')]
    const problems: string[] = []
    for (const file of files) {
      for (const spec of specifiers(readFileSync(file, 'utf8'), file)) {
        if (!spec.startsWith('.')) continue
        const target = resolve(dirname(file), spec.split('?')[0])
        if (
          !allowed.some(
            (a) =>
              target === a || target.startsWith(a + (process.platform === 'win32' ? '\\' : '/'))
          )
        )
          problems.push(`${rel(file)} → ${spec}`)
      }
    }
    expect(problems).toEqual([])
  })

  it('makes the tripwire the first import of every process and thread entry', () => {
    for (const entry of ENTRIES) {
      const src = readFileSync(join(REPO_ROOT, entry), 'utf8')
      const sf = ts.createSourceFile(entry, src, ts.ScriptTarget.Latest, true)
      const first = sf.statements.find(ts.isImportDeclaration)
      expect((first?.moduleSpecifier as ts.StringLiteral | undefined)?.text, entry).toBe(
        './no-network'
      )
    }
  })

  it('is enforced: the rule set catches what it is meant to', () => {
    const scan = (s: string): string[] =>
      scanSource(s, { ...RULES, filePath: 'src/main/ocr/process/x.ts' }).map((f) => f.name)
    expect(scan("import { net } from 'electron'")).toEqual(['electron'])
    expect(scan("import type { MessagePortMain } from 'electron'")).toEqual(['electron'])
    expect(scan("import https from 'node:https'")).toEqual(['node:https'])
    expect(scan("import { spawn } from 'node:child_process'")).toEqual(['node:child_process'])
    expect(scan("const i = require('inspector')")).toEqual(['inspector'])
    expect(scan('await fetch(u)')).toEqual(['fetch'])
    expect(scan('const w = new WebSocket(u)')).toEqual(['WebSocket'])
    expect(scan('const m = require(name)')).toEqual(['require()'])
    expect(scan('await import(`./${t}`)')).toEqual(['import()'])
    expect(scan("import p from './raster-thread?modulePath'")).toEqual([])
    expect(scan("import u from './x.wasm?url'")).toEqual(['./x.wasm?url'])
    expect(scan("import p from '../../../preload/index?modulePath'")).toEqual([
      '../../../preload/index?modulePath'
    ])
    expect(scan("import { a } from '../../../shared/ocr/protocol'")).toEqual([])
  })
})
