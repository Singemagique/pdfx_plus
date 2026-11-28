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
// - node:dns lookup, lookupService, reverse and every resolve*, on the module, on dns.promises and on
//   both Resolver prototypes;
// - node:dgram createSocket;
// - require('electron').net.{fetch, request, resolveHost, isOnline} when Electron exposes it (a
//   utility process does: PR0 measured `{ net, systemPreferences }` with writable, configurable
//   members, and a later require('electron') returns the patched object). In a worker_thread
//   require('electron') throws, so there is nothing to patch there.
//
// Each realm has its own module instances, so a stub installed in the coordinator does not reach a
// worker_thread (PR0 measured the same blindness for an fs spy). Every thread entry imports this
// module itself and reports `tripwireCount()` in its messages; the coordinator sums them into its
// heartbeat and the packaged self-test fails on anything above 0.
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
import { syncBuiltinESMExports } from 'node:module'
import { OcrError } from '../../../shared/ocr/protocol'

let total = 0
const byApi = new Map<string, number>()

/** Attempts the tripwire stopped in this realm since it was installed. */
export function tripwireCount(): number {
  return total
}

/** Per-API attempt counts (API names only, never arguments). For diagnostics and tests. */
export function tripwireDetails(): Record<string, number> {
  return Object.fromEntries(byApi)
}

function trip(api: string): never {
  total++
  byApi.set(api, (byApi.get(api) ?? 0) + 1)
  throw new OcrError('network', `network access is disabled in the OCR process (${api})`)
}

function stub(api: string): (...args: unknown[]) => never {
  // A named function so a stack trace says which API was stopped.
  const fn = function blockedNetworkCall(): never {
    return trip(api)
  }
  return fn
}

/** A stand-in constructor: `new WebSocket(u)` and `WebSocket(u)` both trip. */
function stubClass(api: string): new (...args: unknown[]) => never {
  return function BlockedNetworkClass(): never {
    return trip(api)
  } as unknown as new (...args: unknown[]) => never
}

/**
 * Replace `obj[key]` with `value` for good: non-writable and non-configurable, so later code in
 * this realm cannot quietly put the original back. A missing key is defined anyway (cheap, and a
 * future runtime that adds the API is covered from day one).
 */
function lock(obj: object, key: string, value: unknown): void {
  const desc = Object.getOwnPropertyDescriptor(obj, key)
  if (desc && !desc.configurable) {
    // Not replaceable by definition. Fall back to assignment; if that is refused too, the API stays
    // reachable, so say so loudly instead of pretending.
    try {
      ;(obj as Record<string, unknown>)[key] = value
    } catch {
      // handled by the check below
    }
    if ((obj as Record<string, unknown>)[key] !== value)
      throw new OcrError('init', `tripwire could not replace ${key}`)
    return
  }
  Object.defineProperty(obj, key, {
    value,
    writable: false,
    configurable: false,
    enumerable: desc?.enumerable ?? true
  })
  locked.push([obj, key, value])
}

/** Every slot the tripwire replaced, for `tripwireIntact`. */
const locked: Array<[object, string, unknown]> = []

const GLOBALS = ['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest', 'Request'] as const
const CLASS_GLOBALS = new Set<string>(['WebSocket', 'EventSource', 'XMLHttpRequest', 'Request'])

const DNS_FUNCTIONS = [
  'lookup',
  'lookupService',
  'reverse',
  'resolve',
  'resolve4',
  'resolve6',
  'resolveAny',
  'resolveCaa',
  'resolveCname',
  'resolveMx',
  'resolveNaptr',
  'resolveNs',
  'resolvePtr',
  'resolveSoa',
  'resolveSrv',
  'resolveTlsa',
  'resolveTxt'
] as const

const ELECTRON_NET = ['fetch', 'request', 'resolveHost', 'isOnline'] as const

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
    [dns.Resolver.prototype, 'dns.Resolver'],
    [dns.promises.Resolver.prototype, 'dns.promises.Resolver']
  ]
  for (const [target, label] of dnsTargets) {
    for (const fn of DNS_FUNCTIONS) {
      // Resolver prototypes carry only the resolve*/reverse family.
      if (label.includes('Resolver') && (fn === 'lookup' || fn === 'lookupService')) continue
      lock(target, fn, stub(`${label}.${fn}`))
    }
  }

  lock(dgram, 'createSocket', stub('dgram.createSocket'))

  // `import { request } from 'node:http'` in ESM reads a separate binding; push the patched values
  // into those too.
  syncBuiltinESMExports()

  const electron = electronModule()
  const enet =
    typeof electron === 'object' && electron !== null
      ? (electron as Record<string, unknown>).net
      : undefined
  if (typeof enet === 'object' && enet !== null) {
    for (const name of ELECTRON_NET) lock(enet, name, stub(`electron.net.${name}`))
    electronNet = [...ELECTRON_NET]
  }
}

// On import, once per realm (a module is evaluated once).
install()
