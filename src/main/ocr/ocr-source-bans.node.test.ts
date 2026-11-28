// Privacy layer 1 for the OCR utility process (DESIGN.md §3.9.3): a static source scan of
// src/main/ocr/process/** (the repo has no ESLint; this test is the rule). Everything that runs in
// the "pdfx-ocr" process or its threads must not import Electron or any network module, must not
// read a network global (`fetch` needs no import), and must not load a module by a computed name.
// The tripwire, no-network.ts, is the one file allowed to name those APIs: it is what replaces
// them. src/shared/ocr/** gets the same network rules from src/shared/dom-free.node.test.ts.
//
// On top of the module and global bans: the native escape hatches (process.binding,
// process._linkedBinding, process.dlopen) and a Worker started from a string of code (`eval: true`)
// reach the network, or a realm without the tripwire, with no import at all. And the third-party
// code bundled into these threads (the PDFium glue; PR5 adds the Tesseract glue to THIRD_PARTY) is
// scanned for the same, since our rules do not apply to it at build time.
//
// Two robustness rules from PR0b ride along: every thread is started with the V8 heap caps
// (`threadOptions()`), and nothing in the process reads its environment (which Electron extends).

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

/** Bundled third-party code that runs inside the OCR process (repo-relative). */
const THIRD_PARTY = ['node_modules/@embedpdf/pdfium/dist/index.cjs']

const ESCAPE_MEMBERS = new Set(['binding', '_linkedBinding', 'dlopen'])

/**
 * `process.binding` / `process._linkedBinding` / `process.dlopen` (dotted or bracketed, called or
 * not) and any `new …Worker(…)` given an `eval` option. Returns `line:column name` entries.
 */
function escapeHatches(source: string, file: string): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const out: string[] = []
  const at = (n: ts.Node, name: string): void => {
    const { line, character } = sf.getLineAndCharacterOfPosition(n.getStart(sf))
    out.push(`${line + 1}:${character + 1} ${name}`)
  }
  const visit = (n: ts.Node): void => {
    if (
      (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === 'process'
    ) {
      const member = ts.isPropertyAccessExpression(n)
        ? n.name.text
        : ts.isStringLiteralLike(n.argumentExpression)
          ? n.argumentExpression.text
          : null
      if (member !== null && ESCAPE_MEMBERS.has(member)) at(n, `process.${member}`)
    }
    if (ts.isNewExpression(n) && /Worker$/.test(n.expression.getText(sf))) {
      const options = n.arguments?.[1]
      if (
        options &&
        ts.isObjectLiteralExpression(options) &&
        options.properties.some((p) => p.name && p.name.getText(sf) === 'eval')
      )
        at(n, 'Worker eval')
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}

/**
 * `new …Worker(…)` calls whose options are not `threadOptions()` (budget.ts): every thread of the
 * utility process needs the V8 heap caps, or one thread's OOM kills (Windows) or hangs (Linux) the
 * whole process (PR0b §f). Returns `line:column` entries.
 */
function workersWithoutHeapCaps(source: string, file: string): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const out: string[] = []
  const visit = (n: ts.Node): void => {
    if (ts.isNewExpression(n) && /(^|\.)Worker$/.test(n.expression.getText(sf))) {
      const options = n.arguments?.[1]
      const capped =
        !!options &&
        ts.isCallExpression(options) &&
        options.expression.getText(sf) === 'threadOptions' &&
        options.arguments.length === 0
      if (!capped) {
        const { line, character } = sf.getLineAndCharacterOfPosition(n.getStart(sf))
        out.push(`${line + 1}:${character + 1}`)
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}

/**
 * Reads of the process environment (`process.env`, dotted or bracketed). The child's env is not
 * ours to know: we pass SystemRoot on win32 only, and Electron adds DBUS_SESSION_BUS_ADDRESS on
 * linux and __CF_USER_TEXT_ENCODING on darwin (PR0b), so nothing in the process may depend on it.
 */
function envReads(source: string, file: string): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const out: string[] = []
  const at = (n: ts.Node): void => {
    const { line, character } = sf.getLineAndCharacterOfPosition(n.getStart(sf))
    out.push(`${line + 1}:${character + 1}`)
  }
  const visit = (n: ts.Node): void => {
    if (
      (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === 'process'
    ) {
      const member = ts.isPropertyAccessExpression(n)
        ? n.name.text
        : ts.isStringLiteralLike(n.argumentExpression)
          ? n.argumentExpression.text
          : null
      if (member === 'env') at(n)
    }
    // const { env } = process
    if (
      ts.isVariableDeclaration(n) &&
      n.initializer &&
      ts.isIdentifier(n.initializer) &&
      n.initializer.text === 'process' &&
      ts.isObjectBindingPattern(n.name) &&
      n.name.elements.some((e) => (e.propertyName ?? e.name).getText(sf) === 'env')
    )
      at(n)
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}

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

  it('names no native escape hatch and starts no Worker from code (tripwire excepted)', () => {
    const problems: string[] = []
    for (const file of files) {
      const r = rel(file)
      if (r === TRIPWIRE) continue
      for (const p of escapeHatches(readFileSync(file, 'utf8'), r)) problems.push(`${r}:${p}`)
    }
    expect(problems).toEqual([])
  })

  it('bundled third-party code reaches no escape hatch, child process or network module', () => {
    const banned = [
      /\bprocess\s*(\.\s*|\[\s*['"])(binding|_linkedBinding|dlopen)\b/g,
      /['"](node:)?(child_process|cluster|inspector|worker_threads)['"]/g,
      /\brequire\(\s*['"](node:)?(https?|http2|net|tls|dgram|dns|electron)['"]\s*\)/g,
      /\beval\s*:\s*(true|!0)\b/g
    ]
    const problems: string[] = []
    for (const r of THIRD_PARTY) {
      const src = readFileSync(join(REPO_ROOT, r), 'utf8')
      for (const re of banned) for (const m of src.matchAll(re)) problems.push(`${r}: ${m[0]}`)
    }
    expect(problems).toEqual([])
    // The scan is not vacuous: it does find what it bans.
    const sample = "x = process.binding('tcp_wrap'); require('node:http'); new W(c, { eval: !0 })"
    expect(banned.flatMap((re) => [...sample.matchAll(re)].map((m) => m[0]))).toHaveLength(3)
  })

  it('starts every thread with the V8 heap caps (threadOptions)', () => {
    const problems: string[] = []
    let workers = 0
    for (const file of files) {
      const r = rel(file)
      if (r === TRIPWIRE) continue
      const src = readFileSync(file, 'utf8')
      workers += (src.match(/new Worker\(/g) ?? []).length
      for (const p of workersWithoutHeapCaps(src, r)) problems.push(`${r}:${p}`)
    }
    expect(problems).toEqual([])
    // Not vacuous: the process does start its threads somewhere in here.
    expect(workers).toBeGreaterThan(0)
    const scan = (s: string): number => workersWithoutHeapCaps(s, 'x.ts').length
    expect(scan('new Worker(path, threadOptions())')).toBe(0)
    expect(scan('new Worker(path)')).toBe(1)
    expect(scan('new wt.Worker(path, { resourceLimits: {} })')).toBe(1)
    expect(scan('new Worker(path, threadOptions(other))')).toBe(1)
  })

  it("never reads the process environment (Electron adds its own variables to the child's)", () => {
    const problems: string[] = []
    for (const file of files) {
      const r = rel(file)
      for (const p of envReads(readFileSync(file, 'utf8'), r)) problems.push(`${r}:${p}`)
    }
    expect(problems).toEqual([])
    expect(envReads('const a = process.env.HOME', 'x.ts')).toHaveLength(1)
    expect(envReads("const a = process['env']", 'x.ts')).toHaveLength(1)
    expect(envReads('const { env } = process', 'x.ts')).toHaveLength(1)
    expect(envReads('const { platform } = process', 'x.ts')).toHaveLength(0)
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

    const hatches = (src: string): string[] =>
      escapeHatches(src, 'x.ts').map((f) => f.split(' ').slice(1).join(' '))
    expect(hatches("process.binding('tcp_wrap')")).toEqual(['process.binding'])
    expect(hatches("process._linkedBinding('electron_common_net')")).toEqual([
      'process._linkedBinding'
    ])
    expect(hatches("const d = process['dlopen']")).toEqual(['process.dlopen'])
    expect(hatches("new Worker('fetch(u)', { eval: true })")).toEqual(['Worker eval'])
    expect(hatches('new wt.Worker(code, { eval })')).toEqual(['Worker eval'])
    expect(hatches('new Worker(rasterThreadPath)')).toEqual([])
    expect(hatches('process.memoryUsage.rss()')).toEqual([])
  })
})
