// The OCR network tripwire (DESIGN.md §3.3.1, §3.9.3 privacy layer 2). This module must be the FIRST
// import of every OCR process and thread entry (index.ts, raster-thread.ts, recognize-thread.ts;
// ocr-source-bans.node.test.ts enforces that). Importing it replaces every way JS code in this realm
// could reach the network with a stub that throws `OcrError('network')` and counts the attempt:
//
// - globals: fetch, WebSocket, EventSource, XMLHttpRequest, Request (fetch(new Request(…)) needs no
//   import at all, which is why an import ban alone is not enough);
// - node:http / node:https request and get, node:http2 connect;
// - node:net connect / createConnection and net.Socket.prototype.connect (what every TCP and IPC
//   client in Node ends up calling), node:tls connect;
// - node:dns lookup, lookupService, reverse and every resolve*, on the module and on dns.promises
//   (the listed names plus any other resolve*/lookup*/reverse* the runtime has), and both Resolver
//   constructors: a Resolver's c-ares `_handle` can query a server of the caller's choosing;
// - node:dgram createSocket and the dgram.Socket constructor (a Socket built with its own `lookup`
//   option never touches dns.lookup);
// - require('electron').net.{fetch, request, resolveHost, isOnline} when Electron exposes it (a
//   utility process does: PR0 measured `{ net, systemPreferences }` with writable, configurable
//   members, and a later require('electron') returns the patched object). In a worker_thread
//   require('electron') throws, so there is nothing to patch there;
// - the native escape hatches under all of the above: process.binding (tcp_wrap and cares_wrap are
//   on Node's allow-list, so raw TCP and DNS work through it), process._linkedBinding for every
//   Electron binding the OCR process has no use for (electron_common_net's createURLLoader makes a
//   real request through Chromium's network service), and process.dlopen (a native addon would get
//   past everything). Node's own internals use internalBinding, which is not reachable from here;
// - new realms and processes, which would start without this module: worker_threads.Worker only
//   accepts the thread entries the coordinator registered with `allowThreadEntries` (never
//   `eval: true`, a data: URL or any other file, and no property path leads back to the original
//   class), every child_process export plus ChildProcess.prototype.spawn is stubbed, and so is
//   process.execve.
//
// Each realm has its own module instances, so a stub installed in the coordinator does not reach a
// worker_thread (PR0 measured the same blindness for an fs spy). Every thread entry imports this
// module itself and reports `tripwireCount()` in its messages; the coordinator sums them into its
// heartbeat and the packaged self-test fails on anything above 0. `tripwireSelfCheck()` proves, in
// the realm itself, that the escape hatches trip, without moving that counter.
//
// Not covered (no JS API to stub): a Windows UNC path given to node:fs (SMB). Nothing in the OCR
// process takes a path from the renderer (protocol.ts carries none), and main only passes
// pdfium.wasm's own path.
//
// This is the one file under src/main/ocr/process/ that may name `electron` and the network modules
// (it is allow-listed in ocr-source-bans.node.test.ts).

import http from 'node:http'
import https from 'node:https'
import http2 from 'node:http2'
import net from 'node:net'
import tls from 'node:tls'
import dns from 'node:dns'
import dgram from 'node:dgram'
import childProcess from 'node:child_process'
import workerThreads from 'node:worker_threads'
import { syncBuiltinESMExports } from 'node:module'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OcrError } from '../../../shared/ocr/protocol'
import {
  CHILD_PROCESS_FUNCTIONS,
  DNS_FUNCTIONS,
  DNS_FUNCTION_RE,
  ELECTRON_NET,
  GLOBALS,
  LINKED_BINDINGS_ALLOWED
} from './tripwire-lists'

export { DNS_FUNCTION_RE }

let total = 0
const byApi = new Map<string, number>()
/** Inside `tripwireSelfCheck`: stubs still throw, but count here instead of in `total`. */
let selfChecking = false
let selfCheckTrips = 0

/** Attempts the tripwire stopped in this realm since it was installed. */
export function tripwireCount(): number {
  return total
}

/** Per-API attempt counts (API names only, never arguments). For diagnostics and tests. */
export function tripwireDetails(): Record<string, number> {
  return Object.fromEntries(byApi)
}

function trip(api: string): never {
  if (selfChecking) selfCheckTrips++
  else {
    total++
    byApi.set(api, (byApi.get(api) ?? 0) + 1)
  }
  throw new OcrError('network', `network access is disabled in the OCR process (${api})`)
}

/** Every stub this module made, so tests and the self-check can tell a stub from an original. */
const stubs = new WeakSet<object>()

/** Is `x` one of this realm's tripwire stubs? */
export function isTripwireStub(x: unknown): boolean {
  return (typeof x === 'function' || (typeof x === 'object' && x !== null)) && stubs.has(x)
}

function stub(api: string): (...args: unknown[]) => never {
  // A named function so a stack trace says which API was stopped.
  const fn = function blockedNetworkCall(): never {
    return trip(api)
  }
  stubs.add(fn)
  return fn
}

/** A stand-in constructor: `new WebSocket(u)` and `WebSocket(u)` both trip. */
function stubClass(api: string): new (...args: unknown[]) => never {
  const fn = function BlockedNetworkClass(): never {
    return trip(api)
  } as unknown as new (...args: unknown[]) => never
  stubs.add(fn)
  return fn
}

/** Every slot the tripwire replaced, for `tripwireIntact`. */
const locked: Array<[object, string, unknown]> = []

/**
 * Replace `obj[key]` with `value` for good: non-writable and non-configurable, so later code in
 * this realm cannot quietly put the original back. A missing key is defined anyway (cheap, and a
 * future runtime that adds the API is covered from day one).
 */
function lock(obj: object, key: string, value: unknown): void {
  const desc = Object.getOwnPropertyDescriptor(obj, key)
  if (desc && !desc.configurable) {
    if ('value' in desc && desc.writable) {
      // writable → non-writable is the one change a non-configurable data property still allows.
      Object.defineProperty(obj, key, { value, writable: false })
    } else {
      // Not replaceable by definition (a non-configurable accessor, say). Fall back to assignment;
      // if that is refused too, the API stays reachable, so say so loudly instead of pretending.
      try {
        ;(obj as Record<string, unknown>)[key] = value
      } catch {
        // handled by the check below
      }
      if ((obj as Record<string, unknown>)[key] !== value)
        throw new OcrError('init', `tripwire could not replace ${key}`)
    }
  } else {
    Object.defineProperty(obj, key, {
      value,
      writable: false,
      configurable: false,
      enumerable: desc?.enumerable ?? true
    })
  }
  // Recorded either way: an assigned slot is exactly the one that could be put back later.
  locked.push([obj, key, value])
}

const CLASS_GLOBALS = new Set<string>(['WebSocket', 'EventSource', 'XMLHttpRequest', 'Request'])

/** The Electron module of this realm, if there is one (utility process: yes; thread: no). */
function electronModule(): unknown {
  try {
    // A literal require on purpose: the utility-process bundle keeps it (electron is external), a
    // worker_thread throws here, and plain Node resolves the npm package, whose export is a path
    // string with no `net`.
    return require('electron')
  } catch {
    return null
  }
}

let electronNet: string[] = []

/** The `require('electron').net` members stubbed in this realm (all four in a utility process). */
export function electronNetStubbed(): string[] {
  return [...electronNet]
}

/** Is every replaced API still the stub? (Nothing in this realm put an original back.) */
export function tripwireIntact(): boolean {
  return locked.every(([obj, key, value]) => (obj as Record<string, unknown>)[key] === value)
}

// ---------------------------------------------------------------------------------------------
// worker_threads: only registered thread entries.

let threadEntries: ReadonlySet<string> | null = null

const normalise = (p: string): string => {
  const r = resolve(p)
  return process.platform === 'win32' ? r.toLowerCase() : r
}

/**
 * Register the files `new Worker(file)` may start in this realm: the coordinator's raster and
 * recognize thread bundles. Once per realm; a second call trips (it would widen the list). A realm
 * that never calls this (every thread) cannot start a worker at all.
 */
export function allowThreadEntries(paths: readonly string[]): void {
  if (threadEntries) trip('worker_threads.allowThreadEntries')
  threadEntries = new Set(paths.map(normalise))
}

function checkWorker(filename: unknown, options: unknown): void {
  const api = 'worker_threads.Worker'
  // `eval: true` runs a string of code in a fresh realm that never imports this module.
  if (typeof options === 'object' && options !== null && (options as { eval?: unknown }).eval)
    trip(api)
  let path: string | null = null
  if (filename instanceof URL) path = filename.protocol === 'file:' ? fileURLToPath(filename) : null
  else if (typeof filename === 'string') {
    if (filename.startsWith('file:')) path = fileURLToPath(filename)
    else if (isAbsolute(filename)) path = filename
  }
  // data:, http:, a relative name or anything else: not one of ours.
  if (path === null || !threadEntries?.has(normalise(path))) trip(api)
}

/**
 * A Worker constructor that checks first. Not `class extends Original`: a subclass's own prototype
 * IS the original class (`Object.getPrototypeOf(Worker)`), so the guard would hand out the very
 * constructor it guards. This one shares the original's prototype object (instanceof and every
 * method still work), takes over its `constructor` slot, and inherits the original's statics from
 * the original's parent, so no property path from the module leads back to the original.
 */
function guardedWorker(Original: typeof workerThreads.Worker): typeof workerThreads.Worker {
  const Worker = function Worker(
    this: unknown,
    filename: string | URL,
    options?: workerThreads.WorkerOptions
  ): workerThreads.Worker {
    if (!new.target) throw new TypeError("Class constructor Worker cannot be invoked without 'new'")
    checkWorker(filename, options)
    return Reflect.construct(Original, [filename, options], new.target) as workerThreads.Worker
  } as unknown as typeof workerThreads.Worker
  Object.setPrototypeOf(Worker, Object.getPrototypeOf(Original))
  Object.defineProperty(Worker, 'prototype', { value: Original.prototype, writable: false })
  lock(Original.prototype, 'constructor', Worker)
  stubs.add(Worker)
  return Worker
}

// ---------------------------------------------------------------------------------------------
// The self-check.

/**
 * Call the escape hatches this realm must block, with arguments that are harmless if a stub is
 * missing (no request is ever addressed anywhere), and list the ones that did not trip. Stubs hit
 * here count separately, so `tripwireCount()` is unchanged. Synchronous: nothing else in this realm
 * runs while the separate count is in effect.
 */
export function tripwireSelfCheck(): { checked: string[]; failed: string[] } {
  const p = process as unknown as Record<string, (...args: unknown[]) => unknown>
  const probes: Array<[string, () => unknown]> = [
    ['fetch', () => (globalThis as unknown as { fetch: (u: string) => unknown }).fetch('data:,')],
    ['process.binding', () => p.binding('tcp_wrap')],
    ['process._linkedBinding', () => p._linkedBinding('electron_common_net')],
    ['process.dlopen', () => p.dlopen({ exports: {} }, '\0')],
    ['dns.Resolver', () => new dns.Resolver()],
    ['dns.promises.Resolver', () => new dns.promises.Resolver()],
    // The public constructor takes createSocket's options (Node's typings only show EventEmitter's).
    [
      'dgram.Socket',
      () => new (dgram.Socket as unknown as new (o: object) => unknown)({ type: 'udp4' })
    ],
    ['worker_threads.Worker', () => new workerThreads.Worker('0', { eval: true })],
    // A NUL in the command is refused before anything is spawned, should the stub be missing.
    ['child_process.spawn', () => childProcess.spawn('\0')],
    ['child_process.execFileSync', () => childProcess.execFileSync('\0')]
  ]
  if (electronNet.length > 0) {
    const enet = (electronModule() as { net: Record<string, () => unknown> }).net
    probes.push(['electron.net.isOnline', () => enet.isOnline()])
  }
  const failed: string[] = []
  selfChecking = true
  try {
    for (const [name, call] of probes) {
      const before = selfCheckTrips
      let r: unknown = null
      try {
        r = call()
      } catch {
        // Only a trip counts as a pass: another throw means the original ran and refused.
      }
      if (selfCheckTrips === before) failed.push(name)
      // A real object came back (a stub is missing): release it.
      const o = r as { terminate?: () => unknown; close?: () => unknown; catch?: unknown } | null
      if (o && typeof o.terminate === 'function') void o.terminate()
      else if (o && typeof o.close === 'function') o.close()
      if (r instanceof Promise) r.catch(() => {})
    }
  } finally {
    selfChecking = false
  }
  return { checked: probes.map(([n]) => n), failed }
}

// ---------------------------------------------------------------------------------------------

function install(): void {
  const g = globalThis as unknown as Record<string, unknown>
  for (const name of GLOBALS) lock(g, name, CLASS_GLOBALS.has(name) ? stubClass(name) : stub(name))

  for (const [mod, name] of [
    [http, 'http'],
    [https, 'https']
  ] as const) {
    lock(mod, 'request', stub(`${name}.request`))
    lock(mod, 'get', stub(`${name}.get`))
  }
  lock(http2, 'connect', stub('http2.connect'))

  lock(net, 'connect', stub('net.connect'))
  lock(net, 'createConnection', stub('net.createConnection'))
  lock(net.Socket.prototype, 'connect', stub('net.Socket.connect'))
  lock(tls, 'connect', stub('tls.connect'))

  const dnsTargets: Array<[object, string]> = [
    [dns, 'dns'],
    [dns.promises, 'dns.promises'],
    // Unreachable once the constructors below are stubbed (no instance exists before this runs);
    // kept so an instance obtained some other way still cannot query.
    [dns.Resolver.prototype, 'dns.Resolver'],
    [dns.promises.Resolver.prototype, 'dns.promises.Resolver']
  ]
  for (const [target, label] of dnsTargets) {
    const isResolver = label.endsWith('Resolver')
    const names = new Set<string>(
      DNS_FUNCTIONS.filter((fn) => !isResolver || (fn !== 'lookup' && fn !== 'lookupService'))
    )
    // Whatever else this runtime has: a resolve* added in a later Node is covered too.
    for (const k of Object.getOwnPropertyNames(target))
      if (DNS_FUNCTION_RE.test(k) && typeof (target as Record<string, unknown>)[k] === 'function')
        names.add(k)
    for (const fn of names) lock(target, fn, stub(`${label}.${fn}`))
  }
  lock(dns, 'Resolver', stubClass('dns.Resolver'))
  lock(dns.promises, 'Resolver', stubClass('dns.promises.Resolver'))

  lock(dgram, 'createSocket', stub('dgram.createSocket'))
  lock(dgram, 'Socket', stubClass('dgram.Socket'))

  for (const fn of CHILD_PROCESS_FUNCTIONS) lock(childProcess, fn, stub(`child_process.${fn}`))
  // What every async spawn path (and cluster's captured fork) ends in.
  lock(childProcess.ChildProcess.prototype, 'spawn', stub('child_process.ChildProcess.spawn'))

  lock(workerThreads, 'Worker', guardedWorker(workerThreads.Worker))

  // `import { request } from 'node:http'` in ESM reads a separate binding; push the patched values
  // into those too.
  syncBuiltinESMExports()

  // electron.net first: its getter loads Electron's net module, which takes electron_common_net
  // through process._linkedBinding. After this, the binding is locked away.
  const electron = electronModule()
  const enet =
    typeof electron === 'object' && electron !== null
      ? (electron as Record<string, unknown>).net
      : undefined
  if (typeof enet === 'object' && enet !== null) {
    for (const name of ELECTRON_NET) lock(enet, name, stub(`electron.net.${name}`))
    electronNet = [...ELECTRON_NET]
  }

  const proc = process as unknown as Record<string, unknown>
  lock(proc, 'binding', stub('process.binding'))
  lock(proc, 'dlopen', stub('process.dlopen'))
  // Replaces this process with any program (Node 22.15+, macOS and Linux; Windows throws anyway),
  // which would start without this module, like a child_process spawn.
  lock(proc, 'execve', stub('process.execve'))
  const linked = proc._linkedBinding as ((name: string) => unknown) | undefined
  const guardedLinked = function linkedBinding(name: string): unknown {
    if (typeof name !== 'string' || !LINKED_BINDINGS_ALLOWED.has(name))
      // Binding names are code identifiers; anything else is reduced to a placeholder.
      trip(
        `process._linkedBinding(${typeof name === 'string' && /^[a-z0-9_]{1,64}$/.test(name) ? name : '?'})`
      )
    if (!linked) throw new Error(`No such binding: ${name}`)
    return linked.call(process, name)
  }
  stubs.add(guardedLinked)
  lock(proc, '_linkedBinding', guardedLinked)
}

// On import, once per realm (a module is evaluated once).
install()
