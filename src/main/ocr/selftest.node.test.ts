// The --ocr-selftest session logic, run in vitest against the coordinator over an in-memory port
// pair: once with the real bundled raster and recognize threads (what the packaged app runs), once
// with scripted threads to show a broken render and a tripped wire fail it.

import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { totalmem } from 'node:os'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { Heartbeat } from '../../shared/ocr/protocol'
import { Coordinator, type CoordinatorDeps, type PortLike } from './process/coordinator'
import { STUB_ENGINE_WASM } from './process/stub-engine'
import {
  REQUIRED_CHILD_CHECKS,
  childTripwireFailures,
  selftestSession,
  type SelftestPort
} from './selftest'
import { bundleEntry, type Bundled } from './test-utils/bundle'
import { FakeParent, INIT, harness, settle } from './test-utils/fake-threads'
import { PDFIUM_WASM_PATH } from './test-utils/pdfium-node'

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url))

/** Two cross-wired in-memory ports (structured-clone semantics are not needed here). */
function portPair(): [PortLike & SelftestPort, PortLike & SelftestPort] {
  class P extends EventEmitter {
    peer!: P
    closed = false
    postMessage(msg: unknown): void {
      if (this.closed || this.peer.closed) return
      queueMicrotask(() => this.peer.emit('message', { data: msg }))
    }
    start(): void {}
    close(): void {
      if (this.closed) return
      this.closed = true
      queueMicrotask(() => this.peer.emit('close'))
    }
  }
  const a = new P()
  const b = new P()
  a.peer = b
  b.peer = a
  return [a, b]
}

function heartbeatVia(parent: FakeParent): () => Promise<Heartbeat> {
  return async () => {
    const n = parent.sent.length
    parent.send({ heartbeat: {} })
    await settle()
    const hb = parent.sent.slice(n).find((m) => 'heartbeat' in (m as object)) as {
      heartbeat: Heartbeat
    }
    return hb.heartbeat
  }
}

let raster: Bundled
let recognize: Bundled

beforeAll(async () => {
  raster = await bundleEntry(here('./process/raster-thread.ts'), {
    alias: { '@embedpdf/pdfium': here('../../../node_modules/@embedpdf/pdfium/dist/index.cjs') }
  })
  recognize = await bundleEntry(here('./process/recognize-thread.ts'))
}, 60_000)

afterAll(() => {
  raster?.dispose()
  recognize?.dispose()
})

describe('selftestSession', () => {
  it('passes against the real threads', async () => {
    const parent = new FakeParent()
    const deps: CoordinatorDeps = {
      parent,
      spawnRaster: () => new Worker(raster.file),
      spawnRecognize: () => new Worker(recognize.file),
      loadPdfium: async () => WebAssembly.compile(await readFile(PDFIUM_WASM_PATH)),
      loadEngine: async () => WebAssembly.compile(STUB_ENGINE_WASM),
      system: () => ({ totalmem: totalmem(), availableMemory: totalmem() / 2, cpus: 4 }),
      tripwire: () => 0,
      tripwireIntact: () => true,
      electronNet: () => [],
      selfCheck: () => ({ checked: [], failed: [] }),
      rss: () => 1,
      exit: () => {}
    }
    const c = new Coordinator(deps)
    parent.send({ init: { ...INIT.init, paths: { pdfiumWasm: PDFIUM_WASM_PATH } } })
    const [coordinatorEnd, mainEnd] = portPair()
    parent.send({ port: {} }, [coordinatorEnd])
    const report = await selftestSession(mainEnd, async () => {
      // Real threads answer asynchronously; poll the parent for the heartbeat.
      const n = parent.sent.length
      parent.send({ heartbeat: {} })
      for (let i = 0; i < 100; i++) {
        const hb = parent.sent.slice(n).find((m) => 'heartbeat' in (m as object))
        if (hb) return (hb as { heartbeat: Heartbeat }).heartbeat
        await new Promise((r) => setTimeout(r, 10))
      }
      throw new Error('no heartbeat')
    })
    c.dispose()
    expect(report.failures).toEqual([])
    expect(report.ok).toBe(true)
    expect(report.page).toMatchObject({
      status: 'ok',
      renderDpi: 150,
      raster: { width: 1275, height: 1650 }
    })
    expect(report.heartbeat?.tripwire).toEqual({ process: 0, raster: 0, recognize: 0 })
    expect(report.messagesValid).toBe(true)
  }, 60_000)

  it('fails on a page that never rendered and on a tripped wire', async () => {
    const h = harness({
      pageCount: () => 1,
      tripwire: () => 2,
      raster: (m, t) => ({ type: 'heap-exhausted', taskId: m.taskId, heap: t.heap, tripwire: 0 })
    })
    const c = new Coordinator(h.deps)
    h.parent.send(INIT)
    const [coordinatorEnd, mainEnd] = portPair()
    h.parent.send({ port: {} }, [coordinatorEnd])
    const report = await selftestSession(mainEnd, heartbeatVia(h.parent))
    c.dispose()
    expect(report.ok).toBe(false)
    expect(report.failures.join('\n')).toMatch(/page status too-large/)
    expect(report.failures.join('\n')).toMatch(/network tripwire fired/)
  })
})

describe('childTripwireFailures (what the packaged self-test asks of the child realm)', () => {
  const net = ['fetch', 'request', 'resolveHost', 'isOnline']
  const all = { checked: [...REQUIRED_CHILD_CHECKS], failed: [] }

  it('passes a child whose self-check tripped everything it must', () => {
    expect(childTripwireFailures(net, all)).toEqual([])
  })

  it('fails on a hatch that did not trip, a check that was skipped, or no check at all', () => {
    const text = (f: string[]): string => f.join(' | ')
    expect(
      text(childTripwireFailures(net, { ...all, failed: ['process._linkedBinding'] }))
    ).toMatch(/self-check failed .*process\._linkedBinding/)
    const skipped = all.checked.filter((c) => c !== 'process._linkedBinding')
    expect(text(childTripwireFailures(net, { checked: skipped, failed: [] }))).toMatch(
      /skipped: process\._linkedBinding/
    )
    expect(childTripwireFailures(net, null)).toEqual([
      'no tripwire self-check from the utility process'
    ])
    expect(text(childTripwireFailures(['fetch'], all))).toMatch(/electron\.net stubs/)
  })
})
