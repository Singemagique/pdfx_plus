// A small static scanner that keeps `src/shared/**` DOM-free and Electron-free.
//
// The repo has no ESLint, so this stands in for the design's `no-restricted-globals` /
// `no-restricted-imports` block (DESIGN.md §3.3.1). It parses each file with the TypeScript
// compiler API, so comments, string literals, template text and regex literals can never trigger a
// report: only real syntax nodes are inspected.
//
// What it reports:
// - A value reference to a banned global identifier (`window`, `document`, `self`, `navigator` by
//   default): a bare identifier in an expression, `typeof window`, a shorthand property `{ window }`,
//   or `globalThis.window` / `globalThis['window']`. Property names (`a.window`, `{ window: 1 }`),
//   member declarations and type-only positions (`typeof` in a type query aside) are not references.
//   This is stricter than ESLint's rule in one way: it does not do scope analysis, so a local that
//   *shadows* a banned name (`const self = this`) is reported too. Rename the local.
// - An import of a banned module: static `import`/`export ... from`, `import x = require()`,
//   `require('…')` and `import('…')` (type-only imports included: shared types must not depend on
//   Electron or DOM-only packages either). `require`/`import()` with a non-literal argument is
//   reported as well, because what it loads can't be checked.

import ts from 'typescript'

export interface ScanFinding {
  /** 1-based line. */
  line: number
  /** 1-based column. */
  column: number
  kind: 'global' | 'import' | 'dynamic-import'
  /** The identifier or module specifier. */
  name: string
}

export interface ScanOptions {
  /** Banned global identifiers. */
  globals?: readonly string[]
  /** Banned module specifiers, as exact names or `prefix/*` patterns. */
  modules?: readonly string[]
  /** Also ban relative or alias imports that resolve into these repo folders (e.g. `src/renderer`). */
  forbiddenDirs?: readonly string[]
  /** The scanned file's repo-relative path (for `forbiddenDirs`); defaults to no check. */
  filePath?: string
}

export const DEFAULT_BANNED_GLOBALS = ['window', 'document', 'self', 'navigator'] as const

/**
 * Packages that need a DOM, Electron or a bundler: `electron` itself, the toolkit (which imports
 * Electron), React and the d3 DOM helpers. pdf-lib, fflate, @embedpdf/pdfium and Node built-ins are
 * environment-agnostic and allowed.
 */
export const DEFAULT_BANNED_MODULES = [
  'electron',
  'electron/*',
  '@electron-toolkit/*',
  'react',
  'react/*',
  'react-dom',
  'react-dom/*',
  'd3-selection',
  'd3-zoom',
  '@renderer/*'
] as const

export const DEFAULT_FORBIDDEN_DIRS = ['src/renderer', 'src/main', 'src/preload'] as const

/**
 * The privacy rule for OCR code (DESIGN.md §3.9.3, layer 1): no network modules (bare, `node:` and
 * subpath forms) and no network globals.
 */
export const NETWORK_MODULES = ['http', 'https', 'http2', 'net', 'tls', 'dgram', 'dns']
  .flatMap((m) => [m, `${m}/*`, `node:${m}`, `node:${m}/*`])
  .concat(['undici', 'undici/*', 'node-fetch', 'node-fetch/*'])
export const NETWORK_GLOBALS = ['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest', 'navigator']

function moduleBanned(spec: string, banned: readonly string[]): boolean {
  // Vite query imports (`x?url`, `x?worker`) only exist under a bundler.
  if (/\?[a-z]/i.test(spec)) return true
  for (const b of banned) {
    if (b.endsWith('/*')) {
      const prefix = b.slice(0, -2)
      if (spec === prefix || spec.startsWith(prefix + '/')) return true
    } else if (spec === b) return true
  }
  return false
}

/** Collapse `a/./b/../c` and normalise separators (posix-style, no fs access). */
function normalisePath(p: string): string {
  const out: string[] = []
  for (const part of p.replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return out.join('/')
}

function resolvesInto(
  spec: string,
  filePath: string | undefined,
  dirs: readonly string[]
): boolean {
  if (!filePath || !spec.startsWith('.')) return false
  const dir = normalisePath(filePath).split('/').slice(0, -1).join('/')
  const target = normalisePath(dir + '/' + spec)
  return dirs.some((d) => target === d || target.startsWith(d + '/'))
}

/** Is `id` in a position where it names a property or declaration rather than reading a value? */
function isNonReference(id: ts.Identifier): boolean {
  const p = id.parent
  if (!p) return false
  if (ts.isPropertyAccessExpression(p) && p.name === id) return true
  if (ts.isQualifiedName(p) && p.right === id) return true
  if (
    (ts.isPropertyAssignment(p) ||
      ts.isPropertyDeclaration(p) ||
      ts.isPropertySignature(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isMethodSignature(p) ||
      ts.isGetAccessorDeclaration(p) ||
      ts.isSetAccessorDeclaration(p) ||
      ts.isEnumMember(p)) &&
    p.name === id
  )
    return true
  if (ts.isBindingElement(p) && p.propertyName === id) return true
  if ((ts.isImportSpecifier(p) || ts.isExportSpecifier(p)) && p.propertyName === id) return true
  if (ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p)) return true
  if (ts.isJsxAttribute(p)) return true
  return false
}

/** Is the node inside a type annotation (where `window` would be a type name, not a value)? */
function inTypePosition(node: ts.Node): boolean {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isTypeQueryNode(n)) return false // `typeof window` in a type still reads the global
    if (ts.isTypeNode(n)) return true
    if (ts.isExpression(n) || ts.isStatement(n)) return false
  }
  return false
}

/**
 * `Math` members whose results are implementation-defined in the last ulp (or random), so code
 * that must be bit-reproducible across OSes and V8 versions may not call them.
 */
export const NONDETERMINISTIC_MATH = [
  'random',
  'sin',
  'cos',
  'tan',
  'asin',
  'acos',
  'atan',
  'atan2',
  'sinh',
  'cosh',
  'tanh',
  'asinh',
  'acosh',
  'atanh',
  'exp',
  'expm1',
  'log',
  'log1p',
  'log2',
  'log10',
  'pow',
  'cbrt',
  'hypot'
] as const

/**
 * Report uses of banned `Math` members (`Math.sin`, `Math['exp']`, a destructured
 * `const { cos } = Math`) and the `**` operator (which is `Math.pow`). AST-based like `scanSource`,
 * so comments and strings never count. Works on .ts and .js text. `Math.sqrt` is allowed: IEEE-754
 * requires it to be correctly rounded.
 */
export function scanMath(
  source: string,
  filePath = 'scan.ts',
  banned: readonly string[] = NONDETERMINISTIC_MATH
): ScanFinding[] {
  const bannedSet = new Set(banned)
  const kind = /\.[cm]?js$/.test(filePath) ? ts.ScriptKind.JS : ts.ScriptKind.TS
  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, kind)
  const findings: ScanFinding[] = []
  const report = (node: ts.Node, name: string): void => {
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
    findings.push({ line: line + 1, column: character + 1, kind: 'global', name })
  }
  const isMath = (e: ts.Expression): boolean => ts.isIdentifier(e) && e.text === 'Math'
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && isMath(node.expression)) {
      if (bannedSet.has(node.name.text)) report(node, `Math.${node.name.text}`)
    } else if (ts.isElementAccessExpression(node) && isMath(node.expression)) {
      const arg = node.argumentExpression
      if (!ts.isStringLiteralLike(arg) || bannedSet.has(arg.text))
        report(node, `Math[${ts.isStringLiteralLike(arg) ? arg.text : '?'}]`)
    } else if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      isMath(node.initializer) &&
      ts.isObjectBindingPattern(node.name)
    ) {
      for (const el of node.name.elements) {
        const key = (el.propertyName ?? el.name) as ts.Node
        if (ts.isIdentifier(key) && bannedSet.has(key.text)) report(el, `Math.${key.text}`)
      }
    } else if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.AsteriskAsteriskToken ||
        node.operatorToken.kind === ts.SyntaxKind.AsteriskAsteriskEqualsToken)
    ) {
      report(node.operatorToken, '**')
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return findings
}

/** Scan one TypeScript source text. */
export function scanSource(source: string, opts: ScanOptions = {}): ScanFinding[] {
  const globals = new Set(opts.globals ?? DEFAULT_BANNED_GLOBALS)
  const modules = opts.modules ?? DEFAULT_BANNED_MODULES
  const dirs = opts.forbiddenDirs ?? DEFAULT_FORBIDDEN_DIRS
  const sf = ts.createSourceFile(
    opts.filePath ?? 'scan.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    opts.filePath?.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
  const findings: ScanFinding[] = []
  const report = (node: ts.Node, kind: ScanFinding['kind'], name: string): void => {
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
    findings.push({ line: line + 1, column: character + 1, kind, name })
  }
  const checkSpec = (node: ts.Node, spec: string): void => {
    if (moduleBanned(spec, modules) || resolvesInto(spec, opts.filePath, dirs))
      report(node, 'import', spec)
  }
  const checkCallArg = (node: ts.CallExpression, what: string): void => {
    const arg = node.arguments[0]
    if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)))
      checkSpec(arg, arg.text)
    else report(node, 'dynamic-import', what)
  }

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const spec = node.moduleSpecifier
      if (spec && ts.isStringLiteral(spec)) checkSpec(spec, spec.text)
    } else if (ts.isImportEqualsDeclaration(node)) {
      const ref = node.moduleReference
      if (ts.isExternalModuleReference(ref) && ts.isStringLiteral(ref.expression))
        checkSpec(ref.expression, ref.expression.text)
    } else if (ts.isImportTypeNode(node)) {
      const arg = node.argument
      if (ts.isLiteralTypeNode(arg) && ts.isStringLiteral(arg.literal))
        checkSpec(arg.literal, arg.literal.text)
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) checkCallArg(node, 'import()')
      else if (ts.isIdentifier(node.expression) && node.expression.text === 'require')
        checkCallArg(node, 'require()')
    } else if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'globalThis'
    ) {
      const name = ts.isPropertyAccessExpression(node)
        ? node.name.text
        : ts.isStringLiteralLike(node.argumentExpression)
          ? node.argumentExpression.text
          : null
      if (name !== null && globals.has(name)) report(node, 'global', `globalThis.${name}`)
    } else if (ts.isIdentifier(node)) {
      // A shorthand property `{ window }` is a reference too: its name is not excluded below.
      if (globals.has(node.text) && !isNonReference(node) && !inTypePosition(node))
        report(node, 'global', node.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return findings
}
