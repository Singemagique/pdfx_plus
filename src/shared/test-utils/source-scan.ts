// A small static scanner that keeps `src/shared/**` DOM-free and Electron-free.
//
// The repo has no ESLint, so this stands in for the design's `no-restricted-globals` /
// `no-restricted-imports` block (DESIGN.md §3.3.1). It parses each file with the TypeScript
// compiler API, so comments, string literals, template text and regex literals can never trigger a
// report: only real syntax nodes are inspected.
//
// What it reports:
// - A value reference to a banned global identifier (`DEFAULT_BANNED_GLOBALS`: `window`,
//   `document`, `localStorage`, …): a bare identifier in an expression, `typeof window`, a
//   shorthand property `{ window }`, or a read off the global object — `globalThis` or Node's
//   `global`, through parentheses / `as` / `!` / `satisfies` (`(globalThis as any).window`,
//   `global['window']`, `const { window: w } = globalThis`). Property names (`a.window`,
//   `{ window: 1 }`), member declarations and type-only positions (`typeof` in a type query aside)
//   are not references. This is stricter than ESLint's rule in one way: it does not do scope
//   analysis, so a local that *shadows* a banned name (`const self = this`) is reported too.
//   Rename the local.
// - The global object read through a computed key (`globalThis[k]`) or handed on as a value
//   (`const g = globalThis`, `Reflect.get(globalThis, k)`): what that reaches can't be checked.
// - An import of a banned module: static `import`/`export ... from`, `import x = require()`,
//   `import('…')` and every require-like call — `require`, `module.require`,
//   `process.mainModule?.require`, `process.getBuiltinModule`, `(0, require)`, `createRequire(url)`
//   (type-only imports included: shared types must not depend on Electron or DOM-only packages
//   either). Such a call with a non-literal argument is reported as well, and so is any other use
//   of a loader (`const r = require`, `require.call(…)`, `const req = createRequire(url)`),
//   because what it loads can't be checked.
// Known gap: an object handed in by code outside the scanned file (a parameter that happens to be
// `require` or the global object) can't be followed; the runtime tripwire (DESIGN.md §3.3.1) is
// the layer for that. The network rule set also bans `eval` and `Function`, so a string can't be
// turned into code that reaches `require`.

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
  /**
   * Vite query suffixes allowed on an import (`./thread?modulePath`). Any other `?query` import is
   * reported: it only exists under a bundler. Empty by default (src/shared runs unbundled too).
   */
  allowedQueries?: readonly string[]
}

/**
 * Browser-only globals. tsconfig's default lib includes the DOM, so `tsc` alone would accept them
 * in src/shared; they would then throw in a utilityProcess, a worker_thread or vitest Node.
 */
export const DEFAULT_BANNED_GLOBALS = [
  'window',
  'document',
  'self',
  'navigator',
  'location',
  'history',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'requestIdleCallback',
  'cancelIdleCallback',
  'Image',
  'DOMParser',
  'HTMLElement',
  'HTMLCanvasElement',
  'OffscreenCanvas',
  'createImageBitmap',
  'alert',
  'confirm',
  'prompt',
  'addEventListener',
  'removeEventListener',
  'postMessage',
  'matchMedia',
  'getComputedStyle'
] as const

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
  '@renderer/*',
  // `createRequire` loads anything (Electron included) past the require checks below, and the
  // renderer has no `module` built-in anyway.
  'module',
  'node:module'
] as const

export const DEFAULT_FORBIDDEN_DIRS = ['src/renderer', 'src/main', 'src/preload'] as const

/**
 * The privacy rule for OCR code (DESIGN.md §3.9.3, layer 1): no network modules (bare, `node:` and
 * subpath forms), no network globals and no string-to-code globals.
 */
export const NETWORK_MODULES = ['http', 'https', 'http2', 'net', 'tls', 'dgram', 'dns']
  .flatMap((m) => [m, `${m}/*`, `node:${m}`, `node:${m}/*`])
  .concat(['undici', 'undici/*', 'node-fetch', 'node-fetch/*'])
export const NETWORK_GLOBALS = [
  'fetch',
  'WebSocket',
  'EventSource',
  'XMLHttpRequest',
  'navigator',
  // A string turned into code escapes every rule above (`eval('requ' + 'ire')('https')`).
  'eval',
  'Function'
]

function moduleBanned(
  spec: string,
  banned: readonly string[],
  allowedQueries: readonly string[] = []
): boolean {
  // Vite query imports (`x?url`, `x?worker`) only exist under a bundler.
  const q = spec.indexOf('?')
  if (q >= 0 && /\?[a-z]/i.test(spec)) {
    if (!allowedQueries.includes(spec.slice(q + 1))) return true
    spec = spec.slice(0, q)
  }
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

/** Is `id` the name being declared (a local, parameter, import binding, `declare global`)? */
function isDeclarationName(id: ts.Identifier): boolean {
  const p = id.parent
  return (
    !!p &&
    (ts.isVariableDeclaration(p) ||
      ts.isParameter(p) ||
      ts.isBindingElement(p) ||
      ts.isFunctionDeclaration(p) ||
      ts.isClassDeclaration(p) ||
      ts.isImportSpecifier(p) ||
      ts.isImportClause(p) ||
      ts.isNamespaceImport(p) ||
      ts.isImportEqualsDeclaration(p) ||
      ts.isModuleDeclaration(p)) &&
    p.name === id
  )
}

/** Is `n` wrapped by its parent without changing the value: `(n)`, `n as T`, `<T>n`, `n!`, … */
function isTransparentParent(n: ts.Node): boolean {
  const p = n.parent
  return (
    !!p &&
    (ts.isParenthesizedExpression(p) ||
      ts.isAsExpression(p) ||
      ts.isTypeAssertionExpression(p) ||
      ts.isNonNullExpression(p) ||
      ts.isSatisfiesExpression(p)) &&
    p.expression === n
  )
}

/** Strip the value-preserving wrappers `isTransparentParent` walks up through. */
function unwrap(e: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isTypeAssertionExpression(e) ||
    ts.isNonNullExpression(e) ||
    ts.isSatisfiesExpression(e)
  )
    e = e.expression
  return e
}

/** A literal property key (`.x`, `['x']`, `` [`x`] ``), or null when it is computed. */
function memberName(node: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | null {
  if (ts.isPropertyAccessExpression(node)) return node.name.text
  const arg = node.argumentExpression
  return ts.isStringLiteralLike(arg) ? arg.text : null
}

/** The property a destructuring element reads (`{ a }`, `{ a: b }`, `{ 'a': b }`), or null. */
function bindingKey(el: ts.BindingElement): string | null {
  if (el.dotDotDotToken) return null
  const key = el.propertyName ?? el.name
  return ts.isIdentifier(key) || ts.isStringLiteralLike(key) ? key.text : null
}

const GLOBAL_OBJECT_NAMES = new Set(['globalThis', 'global'])

/** `globalThis`, Node's `global`, or a self-reference of one (`globalThis.globalThis`). */
function isGlobalObject(e: ts.Expression): boolean {
  e = unwrap(e)
  if (ts.isIdentifier(e)) return GLOBAL_OBJECT_NAMES.has(e.text)
  if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
    const name = memberName(e)
    return name !== null && GLOBAL_OBJECT_NAMES.has(name) && isGlobalObject(e.expression)
  }
  return false
}

/** The outermost expression `n` still denotes after transparent wrappers. */
function outermost(n: ts.Node): ts.Node {
  while (isTransparentParent(n)) n = n.parent
  return n
}

/**
 * Is `n` (already `outermost`) only READ THROUGH a literal key: the receiver of a member access,
 * the source of a destructuring, or a `typeof` operand? Anything else (`const g = globalThis`,
 * `f(Math)`, `Reflect.get(globalThis, k)`) hands the object on where no rule can follow it.
 */
function isReadThroughKey(n: ts.Node): boolean {
  const p = n.parent
  if (!p) return false
  if ((ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) && p.expression === n)
    return true
  if (ts.isVariableDeclaration(p) && p.initializer === n && ts.isObjectBindingPattern(p.name))
    return true
  if (
    ts.isBinaryExpression(p) &&
    p.right === n &&
    p.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isObjectLiteralExpression(unwrap(p.left))
  )
    return true
  return ts.isTypeOfExpression(p)
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

/** The script kind a file's extension implies (.js/.mjs/.cjs, .jsx, .tsx, else TS). */
function scriptKind(filePath: string): ts.ScriptKind {
  if (/\.[cm]?js$/.test(filePath)) return ts.ScriptKind.JS
  if (filePath.endsWith('.jsx')) return ts.ScriptKind.JSX
  if (filePath.endsWith('.tsx')) return ts.ScriptKind.TSX
  return ts.ScriptKind.TS
}

/**
 * Report uses of banned `Math` members (`Math.sin`, `Math['exp']`, `(Math as any).exp`,
 * `globalThis.Math.cos`, a destructured `const { cos } = Math`), a computed key on `Math`, `Math`
 * handed on as a value (`const M = Math`: an alias no rule can follow), and the `**` operator
 * (which is `Math.pow`). AST-based like `scanSource`, so comments and strings never count. Works
 * on .ts and .js text. `Math.sqrt` is allowed: IEEE-754 requires it to be correctly rounded.
 * With `integerPow`, `**` between two non-negative integer literals (`2 ** 30`: a constant whose
 * value is exact) is allowed too.
 */
export function scanMath(
  source: string,
  filePath = 'scan.ts',
  banned: readonly string[] = NONDETERMINISTIC_MATH,
  opts: { integerPow?: boolean } = {}
): ScanFinding[] {
  const bannedSet = new Set(banned)
  /** A non-negative integer literal's value, else null. */
  const intLiteral = (e: ts.Expression): number | null => {
    e = unwrap(e)
    return ts.isNumericLiteral(e) && /^\d+$/.test(e.text) ? Number(e.text) : null
  }
  const sf = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(filePath)
  )
  const findings: ScanFinding[] = []
  const report = (node: ts.Node, name: string): void => {
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
    findings.push({ line: line + 1, column: character + 1, kind: 'global', name })
  }
  /** `Math`, `globalThis.Math`, `global['Math']`, through any transparent wrappers. */
  const isMath = (e: ts.Expression): boolean => {
    e = unwrap(e)
    if (ts.isIdentifier(e)) return e.text === 'Math'
    if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e))
      return memberName(e) === 'Math' && isGlobalObject(e.expression)
    return false
  }
  const visit = (node: ts.Node): void => {
    if (
      ts.isExpression(node) &&
      isMath(node) &&
      !isTransparentParent(node) &&
      !(ts.isIdentifier(node) && (isNonReference(node) || isDeclarationName(node))) &&
      !isReadThroughKey(node)
    )
      report(node, 'Math (aliased)')
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
        const key = bindingKey(el)
        if (key === null) report(el, 'Math{…}')
        else if (bannedSet.has(key)) report(el, `Math.${key}`)
      }
    } else if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.AsteriskAsteriskToken ||
        node.operatorToken.kind === ts.SyntaxKind.AsteriskAsteriskEqualsToken)
    ) {
      const base = intLiteral(node.left)
      const exp = intLiteral(node.right)
      const exact =
        opts.integerPow === true &&
        node.operatorToken.kind === ts.SyntaxKind.AsteriskAsteriskToken &&
        base !== null &&
        exp !== null &&
        Number.isSafeInteger(base ** exp)
      if (!exact) report(node.operatorToken, '**')
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return findings
}

/** Members that load a module by name when called: `module.require`, `process.getBuiltinModule`. */
const LOADER_MEMBERS = new Set(['require', 'getBuiltinModule'])

/**
 * Does calling `e` load a module by name? `require`, `module.require`, `process.mainModule?.require`,
 * `process.getBuiltinModule`, `(0, require)`, `createRequire(url)`, through transparent wrappers.
 */
function isModuleLoader(e: ts.Expression): boolean {
  e = unwrap(e)
  if (ts.isIdentifier(e)) return e.text === 'require'
  if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
    const name = memberName(e)
    return name !== null && LOADER_MEMBERS.has(name)
  }
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.CommaToken)
    return isModuleLoader(e.right)
  if (ts.isCallExpression(e)) {
    const c = unwrap(e.expression)
    if (ts.isIdentifier(c)) return c.text === 'createRequire'
    if (ts.isPropertyAccessExpression(c) || ts.isElementAccessExpression(c))
      return memberName(c) === 'createRequire'
  }
  return false
}

/** Scan one TypeScript (or JavaScript, by `filePath`'s extension) source text. */
export function scanSource(source: string, opts: ScanOptions = {}): ScanFinding[] {
  const globals = new Set(opts.globals ?? DEFAULT_BANNED_GLOBALS)
  const modules = opts.modules ?? DEFAULT_BANNED_MODULES
  const dirs = opts.forbiddenDirs ?? DEFAULT_FORBIDDEN_DIRS
  const filePath = opts.filePath ?? 'scan.ts'
  const sf = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(filePath)
  )
  const findings: ScanFinding[] = []
  const report = (node: ts.Node, kind: ScanFinding['kind'], name: string): void => {
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
    findings.push({ line: line + 1, column: character + 1, kind, name })
  }
  const checkSpec = (node: ts.Node, spec: string): void => {
    if (
      moduleBanned(spec, modules, opts.allowedQueries) ||
      resolvesInto(spec.split('?')[0], opts.filePath, dirs)
    )
      report(node, 'import', spec)
  }
  const checkCallArg = (node: ts.CallExpression, what: string): void => {
    const arg = node.arguments[0]
    if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)))
      checkSpec(arg, arg.text)
    else report(node, 'dynamic-import', what)
  }

  /** Is the call's callee position held by `n` (through wrappers and `(0, f)` comma forms)? */
  const isCallee = (n: ts.Node): boolean => {
    for (;;) {
      n = outermost(n)
      const p = n.parent
      if (
        p &&
        ts.isBinaryExpression(p) &&
        p.operatorToken.kind === ts.SyntaxKind.CommaToken &&
        p.right === n
      ) {
        n = p
        continue
      }
      return !!p && ts.isCallExpression(p) && p.expression === n
    }
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
      else if (isModuleLoader(node.expression)) checkCallArg(node, 'require()')
    } else if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      isGlobalObject(node.expression)
    ) {
      const name = memberName(node)
      // A computed key on the global object can name anything.
      if (name === null) {
        if (globals.size > 0) report(node, 'global', 'globalThis[?]')
      } else if (globals.has(name)) report(node, 'global', `globalThis.${name}`)
    } else if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isObjectBindingPattern(node.name) &&
      isGlobalObject(node.initializer)
    ) {
      // `const { fetch: f } = globalThis` (the shorthand `{ fetch }` is caught as an identifier).
      for (const el of node.name.elements) {
        const key = bindingKey(el)
        if (key === null) {
          if (globals.size > 0) report(el, 'global', 'globalThis{…}')
        } else if (el.propertyName && globals.has(key)) report(el, 'global', `globalThis.${key}`)
      }
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isObjectLiteralExpression(unwrap(node.left)) &&
      isGlobalObject(node.right)
    ) {
      // `({ fetch: f } = globalThis)`.
      for (const prop of (unwrap(node.left) as ts.ObjectLiteralExpression).properties) {
        if (ts.isShorthandPropertyAssignment(prop)) continue // an identifier reference
        const name =
          ts.isPropertyAssignment(prop) &&
          (ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name))
            ? prop.name.text
            : null
        if (name === null) {
          if (globals.size > 0) report(prop, 'global', 'globalThis{…}')
        } else if (globals.has(name)) report(prop, 'global', `globalThis.${name}`)
      }
    } else if (ts.isIdentifier(node)) {
      const ref = !isNonReference(node) && !inTypePosition(node)
      // A shorthand property `{ window }` is a reference too: its name is not excluded above.
      if (ref && globals.has(node.text)) report(node, 'global', node.text)
      if (ref && !isDeclarationName(node)) {
        // The global object may only be read through a literal key; an alias escapes the rules.
        if (GLOBAL_OBJECT_NAMES.has(node.text) && globals.size > 0) {
          let top: ts.Node = outermost(node)
          while (
            (ts.isPropertyAccessExpression(top.parent) ||
              ts.isElementAccessExpression(top.parent)) &&
            top.parent.expression === top &&
            isGlobalObject(top.parent)
          )
            top = outermost(top.parent)
          if (!isReadThroughKey(top)) report(node, 'global', `${node.text} (aliased)`)
        }
        // `require` may be called (its argument is checked) or tested with typeof; any other use
        // (`const r = require`, `require.call(…)`) hands it on unchecked. `require.resolve` loads
        // nothing.
        if (node.text === 'require' && !isCallee(node)) {
          const top = outermost(node)
          const p = top.parent
          const resolve =
            ts.isPropertyAccessExpression(p) && p.expression === top && p.name.text === 'resolve'
          if (!resolve && !ts.isTypeOfExpression(p))
            report(node, 'dynamic-import', 'require (aliased)')
        }
        // createRequire(url) must be called on the spot, so that call's argument is checked.
        if (node.text === 'createRequire') {
          const top = outermost(node)
          const call = top.parent
          if (!(isCallee(node) && ts.isCallExpression(call) && isCallee(call)))
            report(node, 'dynamic-import', 'createRequire (aliased)')
        }
      }
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const name = memberName(node)
      if (name !== null && LOADER_MEMBERS.has(name) && !isCallee(node))
        report(node, 'dynamic-import', `.${name} (aliased)`)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return findings
}
