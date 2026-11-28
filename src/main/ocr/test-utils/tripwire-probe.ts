// Test-only probe for no-network.node.test.ts. Bundled (ESM) and run as a child process and as a
// worker_thread: it imports the tripwire FIRST, exactly like a real OCR entry, then calls every API
// the tripwire is meant to stop and reports whether each one threw OcrError('network').
//
// Every target is 127.0.0.1 / localhost on the discard port, so even an unpatched API could only
// reach this machine.

import { tripwireCount, tripwireDetails } from '../process/no-network'
import { request as namedHttpRequest } from 'node:http'
import http from 'node:http'
import https from 'node:https'
import http2 from 'node:http2'
import net from 'node:net'
import tls from 'node:tls'
import dns from 'node:dns'
import dnsPromises from 'node:dns/promises'
import dgram from 'node:dgram'
import { parentPort } from 'node:worker_threads'

const URL_ = 'http://127.0.0.1:9/'
const g = globalThis as unknown as Record<string, unknown>
type AnyFn = (...args: unknown[]) => unknown
type AnyCtor = new (...args: unknown[]) => unknown

const cases: Record<string, () => unknown> = {
  'global.fetch': () => (g.fetch as AnyFn)(URL_),
  'global.WebSocket': () => new (g.WebSocket as AnyCtor)('ws://127.0.0.1:9/'),
  'global.EventSource': () => new (g.EventSource as AnyCtor)(URL_),
  'global.XMLHttpRequest': () => new (g.XMLHttpRequest as AnyCtor)(),
  'global.Request': () => new (g.Request as AnyCtor)(URL_),
  'http.request': () => http.request(URL_),
  'http.get': () => http.get(URL_),
  'http.request (ESM named import)': () => namedHttpRequest(URL_),
  'https.request': () => https.request('https://127.0.0.1:9/'),
  'https.get': () => https.get('https://127.0.0.1:9/'),
  'http2.connect': () => http2.connect('http://127.0.0.1:9'),
  'net.connect': () => net.connect(9, '127.0.0.1'),
  'net.createConnection': () => net.createConnection(9, '127.0.0.1'),
  'net.Socket#connect': () => new net.Socket().connect(9, '127.0.0.1'),
  'tls.connect': () => tls.connect(9, '127.0.0.1'),
  'dns.lookup': () => dns.lookup('localhost', () => {}),
  'dns.lookupService': () => dns.lookupService('127.0.0.1', 9, () => {}),
  'dns.reverse': () => dns.reverse('127.0.0.1', () => {}),
  'dns.resolve': () => dns.resolve('localhost', () => {}),
  'dns.resolve4': () => dns.resolve4('localhost', () => {}),
  'dns.resolve6': () => dns.resolve6('localhost', () => {}),
  'dns.resolveAny': () => dns.resolveAny('localhost', () => {}),
  'dns.resolveCname': () => dns.resolveCname('localhost', () => {}),
  'dns.resolveMx': () => dns.resolveMx('localhost', () => {}),
  'dns.resolveNs': () => dns.resolveNs('localhost', () => {}),
  'dns.resolvePtr': () => dns.resolvePtr('localhost', () => {}),
  'dns.resolveSoa': () => dns.resolveSoa('localhost', () => {}),
  'dns.resolveSrv': () => dns.resolveSrv('localhost', () => {}),
  'dns.resolveTxt': () => dns.resolveTxt('localhost', () => {}),
  'dns.promises.lookup': () => dns.promises.lookup('localhost'),
  'dns/promises.resolve4': () => dnsPromises.resolve4('localhost'),
  'dns.Resolver#resolve4': () => new dns.Resolver().resolve4('localhost', () => {}),
  'dns.promises.Resolver#resolve4': () => new dns.promises.Resolver().resolve4('localhost'),
  'dgram.createSocket': () => dgram.createSocket('udp4')
}

/** A fake `require('electron')` is aliased in for the child-process run; see fake-electron.ts. */
async function electronNet(): Promise<Record<string, () => unknown> | null> {
  try {
    const mod = (await import('electron')) as unknown as { net?: Record<string, AnyFn> }
    const enet = mod.net ?? (mod as { default?: { net?: Record<string, AnyFn> } }).default?.net
    if (!enet || typeof enet !== 'object') return null
    return {
      'electron.net.fetch': () => enet.fetch(URL_),
      'electron.net.request': () => enet.request(URL_),
      'electron.net.resolveHost': () => enet.resolveHost('localhost'),
      'electron.net.isOnline': () => enet.isOnline()
    }
  } catch {
    return null
  }
}

async function run(): Promise<void> {
  const before = tripwireCount()
  const results: Record<string, { threw: boolean; code: string | null }> = {}
  const all = { ...cases, ...((await electronNet()) ?? {}) }
  for (const [name, fn] of Object.entries(all)) {
    try {
      const r = fn()
      // A real (unpatched) client object: close it so the probe exits.
      ;(r as { destroy?: () => void; close?: () => void } | null)?.destroy?.()
      ;(r as { close?: () => void } | null)?.close?.()
      if (r instanceof Promise) await r.catch(() => {})
      results[name] = { threw: false, code: null }
    } catch (e) {
      results[name] = { threw: true, code: (e as { code?: string }).code ?? null }
    }
  }
  const report = { before, after: tripwireCount(), details: tripwireDetails(), results }
  if (parentPort) parentPort.postMessage(report)
  else process.stdout.write(JSON.stringify(report) + '\n')
}

void run()
