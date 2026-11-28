// The network tripwire, run for real (DESIGN.md §3.9.3 privacy layer 2): the probe imports
// no-network.ts first, like every OCR entry, then calls every API the tripwire patches. It runs in
// a child process (with a fake `require('electron')` shaped like the utility process's) and in a
// worker_thread, because a tripwire installed in one realm does not reach another. Each call must be
// counted by its OWN stub (so a stub that is missing but happens to be caught by another one, like
// http.get by net.createConnection, still fails), every DNS function the runtime exposes must be a
// stub, the locks must refuse tampering, and the in-realm self-check must pass without moving the
// counter.

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { bundleEntry, type Bundled } from '../test-utils/bundle'
import type { ProbeReport } from '../test-utils/tripwire-probe'
// Never './no-network' itself here: importing it would install the tripwire in vitest's own realm.
import { CHILD_PROCESS_FUNCTIONS, DNS_FUNCTIONS, ELECTRON_NET, GLOBALS } from './tripwire-lists'

const PROBE = fileURLToPath(new URL('../test-utils/tripwire-probe.ts', import.meta.url))
const TAMPER = fileURLToPath(new URL('../test-utils/tripwire-tamper-probe.ts', import.meta.url))
const FAKE_ELECTRON = fileURLToPath(new URL('../test-utils/fake-electron.ts', import.meta.url))

/** Labels every realm's probe must have exercised (on top of the enumerated DNS ones). */
const REQUIRED = [
  ...GLOBALS,
  'http.request',
  'http.get',
  'https.request',
  'https.get',
  'http2.connect',
  'net.connect',
  'net.createConnection',
  'net.Socket.connect',
  'tls.connect',
  ...DNS_FUNCTIONS.map((f) => `dns.${f}`),
  ...DNS_FUNCTIONS.map((f) => `dns.promises.${f}`),
  'dns.Resolver',
  'dns.promises.Resolver',
  'dgram.createSocket',
  'dgram.Socket',
  'process.binding',
  'process._linkedBinding(electron_common_net)',
  'process.dlopen',
  'worker_threads.Worker',
  'worker_threads.allowThreadEntries',
  'process.execve',
  ...CHILD_PROCESS_FUNCTIONS.map((f) => `child_process.${f}`),
  'child_process.ChildProcess.spawn'
]
const ELECTRON_LABELS = ELECTRON_NET.map((n) => `electron.net.${n}`)

function expectAllTripped(report: ProbeReport, required: string[]): void {
  // The self-check ran first and found every escape hatch blocked, without counting.
  expect(report.selfCheck.failed).toEqual([])
  expect(report.selfCheck.checked).toEqual(
    expect.arrayContaining(['process._linkedBinding', 'process.binding', 'worker_threads.Worker'])
  )
  expect(report.before).toBe(0)

  const labels = report.results.map((r) => r.label)
  expect(labels).toEqual(expect.arrayContaining(required))
  const notTripped = report.results.filter((r) => !r.threw || r.code !== 'network')
  expect(notTripped).toEqual([])

  // Each call was counted once, by its own stub.
  const expected: Record<string, number> = {}
  for (const l of labels) expected[l] = (expected[l] ?? 0) + 1
  expect(report.details).toEqual(expected)
  expect(report.after).toBe(labels.length)

  // Every DNS query function this runtime has is a stub (none left to reach c-ares directly).
  expect(Object.entries(report.dnsStubbed).filter(([, stubbed]) => !stubbed)).toEqual([])

  // Nothing could be put back, and the tripwire still says so.
  expect(Object.entries(report.tamper).filter(([, refused]) => !refused)).toEqual([])
  expect(Object.keys(report.tamper)).toHaveLength(6)
  expect(report.intactAfterTamper).toBe(true)

  // The registered thread entry still starts: the Worker guard is an allow-list, not a ban.
  expect(report.registeredWorker).toBe('echo')
  // And no property path from the guard leads back to the original, unchecked class.
  expect(report.workerLeaks).toEqual([])
}

let processProbe: Bundled
let threadProbe: Bundled
let tamperProbe: Bundled

beforeAll(async () => {
  processProbe = await bundleEntry(PROBE, { format: 'esm', alias: { electron: FAKE_ELECTRON } })
  threadProbe = await bundleEntry(PROBE, { format: 'esm' })
  tamperProbe = await bundleEntry(TAMPER, { format: 'esm' })
}, 30_000)

afterAll(() => {
  processProbe?.dispose()
  threadProbe?.dispose()
  tamperProbe?.dispose()
})

describe('no-network tripwire', () => {
  it('stops and counts every patched API in a process, electron.net included', () => {
    const run = spawnSync(process.execPath, [processProbe.file], {
      encoding: 'utf8',
      timeout: 20_000,
      env: { ...process.env, NODE_OPTIONS: '' }
    })
    expect(run.status, run.stderr).toBe(0)
    const report = JSON.parse(run.stdout.trim().split('\n').pop() ?? '{}') as ProbeReport
    expectAllTripped(report, [...REQUIRED, ...ELECTRON_LABELS])
    expect(report.selfCheck.checked).toContain('electron.net.isOnline')
    // Nothing the probe did reached a real socket: no unhandled connection error was printed.
    expect(run.stderr).toBe('')
  }, 30_000)

  it('stops and counts every patched API inside a worker_thread', async () => {
    const worker = new Worker(threadProbe.file)
    const report = await new Promise<ProbeReport>((resolve, reject) => {
      worker.once('message', resolve)
      worker.once('error', reject)
    })
    await worker.terminate()
    // No electron in a thread: require('electron') throws there, so only the Node APIs exist.
    expectAllTripped(report, REQUIRED)
    expect(report.results.filter((r) => r.label.startsWith('electron.net'))).toEqual([])
  }, 30_000)

  it('watches a slot it could only assign: putting something back there breaks tripwireIntact', () => {
    const run = spawnSync(process.execPath, [tamperProbe.file], {
      encoding: 'utf8',
      timeout: 20_000,
      env: { ...process.env, NODE_OPTIONS: '' }
    })
    expect(run.status, run.stderr).toBe(0)
    expect(JSON.parse(run.stdout.trim())).toEqual({
      intactBefore: true,
      tripped: true,
      count: 1,
      intactAfter: false
    })
  }, 30_000)
})
