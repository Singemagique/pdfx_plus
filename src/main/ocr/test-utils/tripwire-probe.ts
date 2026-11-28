// Test-only probe for no-network.node.test.ts. Bundled (ESM) and run as a child process and as a
// worker_thread: it imports the tripwire FIRST, exactly like a real OCR entry, then calls every API
// the tripwire is meant to stop and reports, per call, whether it threw OcrError('network') and which
// stub counted it. The DNS cases are enumerated from the runtime's own dns / dns.promises exports,
// so a query function the tripwire missed shows up as a case that did not trip.
//
// Every target is 127.0.0.1 / localhost on the discard port, a data: URL or a NUL-poisoned
// argument, so even an unpatched API could only reach this machine (or nothing at all).

import {
  DNS_FUNCTION_RE,
  allowThreadEntries,
  isTripwireStub,
  tripwireCount,
  tripwireDetails,
  tripwireIntact,
  tripwireSelfCheck
} from '../process/no-network'
import { request as namedHttpRequest } from 'node:http'
import http from 'node:http'
import https from 'node:https'
import http2 from 'node:http2'
import net from 'node:net'
import tls from 'node:tls'
import dns from 'node:dns'
import dnsPromises from 'node:dns/promises'
import dgram from 'node:dgram'
import cp from 'node:child_process'
import { Worker, parentPort, workerData } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const URL_ = 'http://127.0.0.1:9/'
const g = globalThis as unknown as Record<string, unknown>
const proc = process as unknown as Record<string, (...args: unknown[]) => unknown>
type AnyFn = (...args: unknown[]) => unknown
type AnyCtor = new (...args: unknown[]) => unknown
const node = process.execPath
const SELF = fileURLToPath(import.meta.url)

/** [the stub label expected to count the call, the call]. A label may appear more than once. */
type Case = [label: string, call: () => unknown]

function dnsCases(): Case[] {
  const out: Case[] = []
  const args = (k: string): unknown[] =>
    k === 'lookupService' ? ['127.0.0.1', 9] : k === 'reverse' ? ['127.0.0.1'] : ['localhost']
  for (const [obj, label, cb] of [
    [dns, 'dns', true],
    [dns.promises, 'dns.promises', false]
  ] as const) {
    for (const k of Object.getOwnPropertyNames(obj)) {
      const fn = (obj as unknown as Record<string, unknown>)[k]
      if (!DNS_FUNCTION_RE.test(k) || typeof fn !== 'function') continue
      out.push([
        `${label}.${k}`,
        () => (fn as AnyFn).apply(obj, cb ? [...args(k), () => {}] : args(k))
      ])
    }
  }
  return out
}

const cases: Case[] = [
  ['fetch', () => (g.fetch as AnyFn)(URL_)],
  ['WebSocket', () => new (g.WebSocket as AnyCtor)('ws://127.0.0.1:9/')],
  ['EventSource', () => new (g.EventSource as AnyCtor)(URL_)],
  ['XMLHttpRequest', () => new (g.XMLHttpRequest as AnyCtor)()],
  ['Request', () => new (g.Request as AnyCtor)(URL_)],
  ['http.request', () => http.request(URL_)],
  // An ESM named binding. This one trips even without syncBuiltinESMExports (measured on Node 24
  // and on Electron 38's Node 22), so it cannot catch a missing sync; the `Worker` named import
  // above can: without the sync it stays the original class and the three Worker cases below do
  // not trip (measured on both). The app's bundles are CJS anyway, where only the module object
  // matters.
  ['http.request', () => namedHttpRequest(URL_)],
  ['http.get', () => http.get(URL_)],
  ['https.request', () => https.request('https://127.0.0.1:9/')],
  ['https.get', () => https.get('https://127.0.0.1:9/')],
  ['http2.connect', () => http2.connect('http://127.0.0.1:9')],
  ['net.connect', () => net.connect(9, '127.0.0.1')],
  ['net.createConnection', () => net.createConnection(9, '127.0.0.1')],
  ['net.Socket.connect', () => new net.Socket().connect(9, '127.0.0.1')],
  ['tls.connect', () => tls.connect(9, '127.0.0.1')],
  ...dnsCases(),
  ['dns.promises.resolve4', () => dnsPromises.resolve4('localhost')],
  ['dns.Resolver', () => new dns.Resolver()],
  ['dns.promises.Resolver', () => new dns.promises.Resolver()],
  ['dgram.createSocket', () => dgram.createSocket('udp4')],
  [
    // Its own lookup never reaches the dns.lookup stub.
    'dgram.Socket',
    () =>
      new (dgram.Socket as unknown as AnyCtor)({
        type: 'udp4',
        lookup: (_h: string, _o: unknown, cb: (e: null, a: string, f: number) => void) =>
          cb(null, '127.0.0.1', 4)
      })
  ],
  ['process.binding', () => proc.binding('tcp_wrap')],
  ['process.binding', () => proc.binding('cares_wrap')],
  ['process._linkedBinding(electron_common_net)', () => proc._linkedBinding('electron_common_net')],
  [
    'process._linkedBinding(electron_common_shell)',
    () => proc._linkedBinding('electron_common_shell')
  ],
  ['process.dlopen', () => proc.dlopen({ exports: {} }, join(dirname(SELF), 'no-such-addon.node'))],
  ['worker_threads.Worker', () => new Worker(`fetch(${JSON.stringify(URL_)})`, { eval: true })],
  ['worker_threads.Worker', () => new Worker(new URL('data:text/javascript,0'))],
  // An absolute file nobody registered (it does not even exist).
  ['worker_threads.Worker', () => new Worker(join(dirname(SELF), 'not-a-thread-entry.js'))],
  ['worker_threads.allowThreadEntries', () => allowThreadEntries(['/anything.js'])],
  ['child_process.spawn', () => cp.spawn(node, ['-e', '0'])],
  ['child_process.spawnSync', () => cp.spawnSync(node, ['-e', '0'])],
  ['child_process.exec', () => cp.exec(`"${node}" -e 0`)],
  ['child_process.execSync', () => cp.execSync(`"${node}" -e 0`)],
  ['child_process.execFile', () => cp.execFile(node, ['-e', '0'])],
  ['child_process.execFileSync', () => cp.execFileSync(node, ['-e', '0'])],
  ['child_process.fork', () => cp.fork(join(dirname(SELF), 'no-such-module.js'))],
  [
    'child_process.ChildProcess.spawn',
    // Not in Node's typings, but public: what spawn() itself calls on a new ChildProcess.
    () =>
      (new cp.ChildProcess() as unknown as { spawn: (o: object) => unknown }).spawn({
        file: node,
        args: [node, '-e', '0'],
        stdio: 'ignore'
      })
  ]
]

/** A fake `require('electron')` is aliased in for the child-process run; see fake-electron.ts. */
async function electronNet(): Promise<Case[]> {
  try {
    const mod = (await import('electron')) as unknown as { net?: Record<string, AnyFn> }
    const enet = mod.net ?? (mod as { default?: { net?: Record<string, AnyFn> } }).default?.net
    if (!enet || typeof enet !== 'object') return []
    return [
      ['electron.net.fetch', () => enet.fetch(URL_)],
      ['electron.net.request', () => enet.request(URL_)],
      ['electron.net.resolveHost', () => enet.resolveHost('localhost')],
      ['electron.net.isOnline', () => enet.isOnline()]
    ]
  } catch {
    return []
  }
}

/** Attempts to put an original back; each must be refused (and leave the tripwire intact). */
const tamper: Record<string, () => void> = {
  'assign http.request': () => {
    ;(http as unknown as Record<string, unknown>).request = () => {}
  },
  'defineProperty net.connect': () => {
    Object.defineProperty(net, 'connect', { value: () => {} })
  },
  'assign globalThis.fetch': () => {
    g.fetch = () => {}
  },
  'assign process.binding': () => {
    ;(process as unknown as Record<string, unknown>).binding = () => {}
  },
  'delete process._linkedBinding': () => {
    delete (process as unknown as Record<string, unknown>)._linkedBinding
  },
  'defineProperty child_process.spawn': () => {
    Object.defineProperty(cp, 'spawn', { value: () => {}, configurable: true })
  }
}

export interface ProbeReport {
  selfCheck: { checked: string[]; failed: string[] }
  before: number
  after: number
  details: Record<string, number>
  results: Array<{ label: string; threw: boolean; code: string | null }>
  /** Every DNS function the runtime exposes on dns / dns.promises, and whether it is a stub. */
  dnsStubbed: Record<string, boolean>
  tamper: Record<string, boolean>
  intactAfterTamper: boolean
  /** A registered thread entry still starts. */
  registeredWorker: string
}

async function registeredWorker(): Promise<string> {
  const w = new Worker(SELF, { workerData: { echo: true } })
  return new Promise((resolve) => {
    w.once('message', (m) => resolve(String(m)))
    w.once('error', (e) => resolve(`error: ${(e as Error).message}`))
  })
}

async function run(): Promise<void> {
  // First: it must not move the counter.
  const selfCheck = tripwireSelfCheck()
  // Like index.ts: register the realm's thread entries once, before anything else runs.
  allowThreadEntries([SELF])
  const before = tripwireCount()
  const results: ProbeReport['results'] = []
  for (const [label, fn] of [...cases, ...(await electronNet())]) {
    try {
      const r = fn()
      // A real (unpatched) client object: close it so the probe exits.
      ;(r as { destroy?: () => void } | null)?.destroy?.()
      ;(r as { close?: () => void } | null)?.close?.()
      ;(r as { kill?: () => void } | null)?.kill?.()
      ;(r as { terminate?: () => void } | null)?.terminate?.()
      if (r instanceof Promise) await r.catch(() => {})
      results.push({ label, threw: false, code: null })
    } catch (e) {
      results.push({ label, threw: true, code: (e as { code?: string }).code ?? null })
    }
  }
  const after = tripwireCount()
  const details = tripwireDetails()

  const dnsStubbed: Record<string, boolean> = {}
  for (const [obj, label] of [
    [dns, 'dns'],
    [dns.promises, 'dns.promises']
  ] as const)
    for (const k of Object.getOwnPropertyNames(obj))
      if (DNS_FUNCTION_RE.test(k))
        dnsStubbed[`${label}.${k}`] = isTripwireStub((obj as unknown as Record<string, unknown>)[k])

  const tamperResults: Record<string, boolean> = {}
  for (const [name, fn] of Object.entries(tamper)) {
    try {
      fn()
      tamperResults[name] = false
    } catch {
      tamperResults[name] = true
    }
  }
  const report: ProbeReport = {
    selfCheck,
    before,
    after,
    details,
    results,
    dnsStubbed,
    tamper: tamperResults,
    intactAfterTamper: tripwireIntact(),
    registeredWorker: await registeredWorker()
  }
  if (parentPort) parentPort.postMessage(report)
  else process.stdout.write(JSON.stringify(report) + '\n')
}

if ((workerData as { echo?: boolean } | null)?.echo) parentPort?.postMessage('echo')
else void run()
