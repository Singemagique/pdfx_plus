// The network tripwire, run for real (DESIGN.md §3.9.3 privacy layer 2): the probe imports
// no-network.ts first, like every OCR entry, then calls every API the tripwire patches. It runs in
// a child process (with a fake `require('electron')` shaped like the utility process's) and in a
// worker_thread, because a tripwire installed in one realm does not reach another.

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { bundleEntry, type Bundled } from '../test-utils/bundle'

const PROBE = fileURLToPath(new URL('../test-utils/tripwire-probe.ts', import.meta.url))
const FAKE_ELECTRON = fileURLToPath(new URL('../test-utils/fake-electron.ts', import.meta.url))

interface Report {
  before: number
  after: number
  details: Record<string, number>
  results: Record<string, { threw: boolean; code: string | null }>
}

const NODE_APIS = [
  'global.fetch',
  'global.WebSocket',
  'global.EventSource',
  'global.XMLHttpRequest',
  'global.Request',
  'http.request',
  'http.get',
  'http.request (ESM named import)',
  'https.request',
  'https.get',
  'http2.connect',
  'net.connect',
  'net.createConnection',
  'net.Socket#connect',
  'tls.connect',
  'dns.lookup',
  'dns.lookupService',
  'dns.reverse',
  'dns.resolve',
  'dns.resolve4',
  'dns.resolve6',
  'dns.resolveAny',
  'dns.resolveCname',
  'dns.resolveMx',
  'dns.resolveNs',
  'dns.resolvePtr',
  'dns.resolveSoa',
  'dns.resolveSrv',
  'dns.resolveTxt',
  'dns.promises.lookup',
  'dns/promises.resolve4',
  'dns.Resolver#resolve4',
  'dns.promises.Resolver#resolve4',
  'dgram.createSocket'
]
const ELECTRON_APIS = [
  'electron.net.fetch',
  'electron.net.request',
  'electron.net.resolveHost',
  'electron.net.isOnline'
]

function expectAllTripped(report: Report, apis: string[]): void {
  expect(report.before).toBe(0)
  const notTripped = apis.filter(
    (a) => !report.results[a]?.threw || report.results[a]?.code !== 'network'
  )
  expect(notTripped).toEqual([])
  // Every stopped call is counted exactly once.
  expect(report.after).toBe(apis.length)
  expect(Object.values(report.details).reduce((a, b) => a + b, 0)).toBe(apis.length)
}

let processProbe: Bundled
let threadProbe: Bundled

beforeAll(async () => {
  processProbe = await bundleEntry(PROBE, { format: 'esm', alias: { electron: FAKE_ELECTRON } })
  threadProbe = await bundleEntry(PROBE, { format: 'esm' })
}, 30_000)

afterAll(() => {
  processProbe?.dispose()
  threadProbe?.dispose()
})

describe('no-network tripwire', () => {
  it('stops and counts every patched API in a process, electron.net included', () => {
    const run = spawnSync(process.execPath, [processProbe.file], {
      encoding: 'utf8',
      timeout: 20_000,
      env: { ...process.env, NODE_OPTIONS: '' }
    })
    expect(run.status, run.stderr).toBe(0)
    const report = JSON.parse(run.stdout.trim().split('\n').pop() ?? '{}') as Report
    expectAllTripped(report, [...NODE_APIS, ...ELECTRON_APIS])
    // Nothing the probe did reached a real socket: no unhandled connection error was printed.
    expect(run.stderr).toBe('')
  }, 30_000)

  it('stops and counts every patched API inside a worker_thread', async () => {
    const worker = new Worker(threadProbe.file)
    const report = await new Promise<Report>((resolve, reject) => {
      worker.once('message', resolve)
      worker.once('error', reject)
    })
    await worker.terminate()
    // No electron in a thread: require('electron') throws there, so only the Node APIs exist.
    expectAllTripped(report, NODE_APIS)
    expect(Object.keys(report.results).filter((k) => k.startsWith('electron'))).toEqual([])
  }, 30_000)
})
