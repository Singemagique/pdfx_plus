// The REAL thread entries, bundled the way `?modulePath` bundles them and run as worker_threads
// under the coordinator: PDFium WASM inside a worker_thread opening a SharedArrayBuffer source with
// FPDF_LoadCustomDocument (PR0 only ran PDFium on a main thread; DESIGN.md §3.3.1 step 3 names this
// as PR4a's first test), the posted WebAssembly.Module reaching the recognize thread, transferred
// grey bitmaps, and every thread's tripwire counter at 0.

import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { availableParallelism, totalmem } from 'node:os'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PDFDocument, degrees, rgb } from 'pdf-lib'

import {
  parseFromOcr,
  type FromOcr,
  type Heartbeat,
  type PageResult
} from '../../../shared/ocr/protocol'
import { THREAD_RESOURCE_LIMITS, threadOptions } from './budget'
import { Coordinator, isThreadOom } from './coordinator'
import { DEFAULT_RASTER_LIMITS } from './raster-core'
import { STUB_ENGINE_WASM } from './stub-engine'
import type { FromRaster, ToRaster } from './thread-messages'
import { isV8FatalOom } from '../supervisor'
import { bundleEntry, type Bundled } from '../test-utils/bundle'
import { FakeParent, FakePort, INIT } from '../test-utils/fake-threads'
import { PDFIUM_WASM_PATH } from '../test-utils/pdfium-node'

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url))

let raster: Bundled
let recognize: Bundled
let parent: FakeParent
let port: FakePort
let coordinator: Coordinator

function waitFor<T>(pred: () => T | undefined, ms = 15_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now()
    const tick = (): void => {
      const v = pred()
      if (v !== undefined) resolve(v)
      else if (Date.now() - t0 > ms) reject(new Error('timed out'))
      else setTimeout(tick, 10)
    }
    tick()
  })
}

const sent = (): FromOcr[] => port.sent as FromOcr[]

beforeAll(async () => {
  // Production keeps @embedpdf/pdfium external and require()s its CJS build from app.asar; bundle
  // that same CJS file here (the package's "import" condition would pick the ESM build, whose
  // import.meta.url does not survive a CJS bundle).
  raster = await bundleEntry(here('./raster-thread.ts'), {
    alias: { '@embedpdf/pdfium': here('../../../../node_modules/@embedpdf/pdfium/dist/index.cjs') }
  })
  recognize = await bundleEntry(here('./recognize-thread.ts'))
  parent = new FakeParent()
  coordinator = new Coordinator({
    parent,
    // The production heap caps: the real threads must work under them.
    spawnRaster: () => new Worker(raster.file, threadOptions()),
    spawnRecognize: () => new Worker(recognize.file, threadOptions()),
    loadPdfium: async () => WebAssembly.compile(await readFile(PDFIUM_WASM_PATH)),
    loadEngine: async () => WebAssembly.compile(STUB_ENGINE_WASM),
    system: () => ({
      totalmem: totalmem(),
      availableMemory: totalmem() / 2,
      cpus: availableParallelism()
    }),
    tripwire: () => 0,
    tripwireIntact: () => true,
    electronNet: () => [],
    selfCheck: () => ({ checked: [], failed: [] }),
    rss: () => process.memoryUsage.rss(),
    exit: () => {}
  })
  parent.send({ init: { ...INIT.init, paths: { pdfiumWasm: PDFIUM_WASM_PATH } } })
  port = new FakePort()
  parent.send({ port: {} }, [port])
}, 60_000)

afterAll(() => {
  coordinator?.dispose()
  raster?.dispose()
  recognize?.dispose()
})

describe('real raster and recognize threads', () => {
  it('opens, renders grey and round-trips the stub recognizer', async () => {
    const doc = await PDFDocument.create()
    const p0 = doc.addPage([612, 792])
    // Top tenth of the page solid black: inkFrac ≈ 0.1 whatever the DPI.
    p0.drawRectangle({ x: 0, y: 792 - 79.2, width: 612, height: 79.2, color: rgb(0, 0, 0) })
    const p1 = doc.addPage([612, 792])
    p1.setRotation(degrees(90))
    p1.drawRectangle({ x: 0, y: 0, width: 306, height: 792, color: rgb(0, 0, 0) })
    port.send({ open: { src: 'doc', bytes: await doc.save() } })
    await waitFor(() => sent().find((m) => 'opened' in m))
    expect(sent().find((m) => 'opened' in m)).toEqual({ opened: { src: 'doc', pageCount: 2 } })

    port.send({
      recognize: {
        jobId: 'j1',
        src: 'doc',
        pages: [
          { index: 0, userUnit: 1, width: 612, height: 792 },
          // pdf.js frame of a /Rotate 90 page: width and height swap.
          { index: 1, userUnit: 1, width: 792, height: 612 }
        ],
        opts: { langs: ['eng'], renderDpi: 100 }
      }
    })
    await waitFor(() => sent().find((m) => 'jobDone' in m))
    const results = sent()
      .filter((m): m is Extract<FromOcr, { result: unknown }> => 'result' in m)
      .map((m) => m.result)
      .sort((a, b) => a.index - b.index)
    const [r0, r1] = results.map((r) => r.page) as PageResult[]
    expect(r0).toMatchObject({ status: 'ok', renderDpi: 100, raster: { width: 850, height: 1100 } })
    expect(r0.recognition?.inkFrac).toBeCloseTo(0.1, 2)
    expect(r1).toMatchObject({ status: 'ok', raster: { width: 1100, height: 850 } })
    expect(r1.recognition?.inkFrac).toBeCloseTo(0.5, 2)
    expect(sent().find((m) => 'jobDone' in m)).toEqual({
      jobDone: { jobId: 'j1', done: 2, failed: 0, cancelled: false }
    })
  }, 60_000)

  it('fails a frame mismatch in the real thread', async () => {
    const before = sent().length
    port.send({
      recognize: {
        jobId: 'j2',
        src: 'doc',
        pages: [{ index: 1, userUnit: 1, width: 612, height: 792 }],
        opts: { langs: ['eng'], renderDpi: 72 }
      }
    })
    await waitFor(() =>
      sent()
        .slice(before)
        .find((m) => 'jobDone' in m)
    )
    const r = sent()
      .slice(before)
      .find((m): m is Extract<FromOcr, { result: unknown }> => 'result' in m)
    expect(r?.result.page).toMatchObject({ status: 'failed', reason: 'frame-mismatch' })
  }, 30_000)

  it('triages in the real thread and answers in protocol shape (PR4b)', async () => {
    const before = sent().length
    port.send({ triage: { src: 'doc' } })
    const done = await waitFor(() =>
      sent()
        .slice(before)
        .find((m): m is Extract<FromOcr, { triaged: unknown }> => 'triaged' in m && m.triaged.done)
    )
    // Two vector-only pages, no text: blank, at the fallback DPI in their own frames.
    expect(done.triaged.pages).toEqual([
      expect.objectContaining({ index: 0, pageClass: 'blank', renderDpi: 300 }),
      expect.objectContaining({
        index: 1,
        pageClass: 'blank',
        raster: { width: 3300, height: 2550 }
      })
    ])
    for (const m of sent().slice(before)) expect(() => parseFromOcr(m)).not.toThrow()
  }, 30_000)

  it('reports every thread tripwire counter at 0', async () => {
    const n = parent.sent.length
    parent.send({ heartbeat: {} })
    const hb = await waitFor(
      () =>
        (
          parent.sent.slice(n).find((m) => 'heartbeat' in (m as object)) as
            | { heartbeat: Heartbeat }
            | undefined
        )?.heartbeat
    )
    expect(hb.tripwire).toEqual({ process: 0, raster: 0, recognize: 0 })
    expect(hb.threads.raster).toBe(1)
  })
})

describe('the raster thread entry itself (PDFium shimmed)', () => {
  // raster-thread.ts bundled with '@embedpdf/pdfium' swapped for test-utils/pdfium-shim.ts and
  // driven message by message, so the thread's own wiring (printErr into the engine, the poisoned
  // flag) is what is under test, not raster-core's.
  let shimmed: Bundled
  let pdfium: WebAssembly.Module
  const live: Worker[] = []

  beforeAll(async () => {
    shimmed = await bundleEntry(here('./raster-thread.ts'), {
      alias: { '@embedpdf/pdfium': here('../test-utils/pdfium-shim.ts') }
    })
    pdfium = await WebAssembly.compile(await readFile(PDFIUM_WASM_PATH))
  }, 60_000)

  afterAll(async () => {
    for (const w of live) await w.terminate()
    shimmed?.dispose()
  })

  async function thread(mode: string): Promise<(msg: ToRaster) => Promise<FromRaster>> {
    const w = new Worker(shimmed.file, { env: { ...process.env, PDFX_TEST_PDFIUM_SHIM: mode } })
    live.push(w)
    const inbox: FromRaster[] = []
    const waiting: Array<(m: FromRaster) => void> = []
    w.on('message', (m: FromRaster) => {
      const next = waiting.shift()
      if (next) next(m)
      else inbox.push(m)
    })
    const ask = (msg: ToRaster): Promise<FromRaster> => {
      w.postMessage(msg)
      return new Promise((resolve) => {
        const queued = inbox.shift()
        if (queued) resolve(queued)
        else waiting.push(resolve)
      })
    }
    const ready = await ask({ type: 'init', pdfium, limits: DEFAULT_RASTER_LIMITS })
    expect(ready).toMatchObject({ type: 'ready', tripwire: 0, selfCheckFailed: [] })
    const doc = await PDFDocument.create()
    doc.addPage([612, 792]).drawRectangle({ x: 72, y: 72, width: 100, height: 100 })
    const bytes = await doc.save()
    const sab = new SharedArrayBuffer(bytes.length)
    new Uint8Array(sab).set(bytes)
    expect(await ask({ type: 'open', src: 's', data: sab, count: true })).toMatchObject({
      type: 'opened',
      pageCount: 1
    })
    return ask
  }

  const render = (taskId: number): ToRaster => ({
    type: 'render',
    taskId,
    src: 's',
    index: 0,
    dpi: 72,
    userUnit: 1,
    frame: { width: 612, height: 792 }
  })

  it('control: an unshimmed render comes back rendered', async () => {
    const ask = await thread('none')
    expect(await ask(render(1))).toMatchObject({ type: 'rendered', taskId: 1, width: 612 })
  }, 30_000)

  it('a "Cannot enlarge memory" line printed during the render discards the bitmap', async () => {
    const ask = await thread('enlarge')
    // Not `rendered` (an all-white page would read as no text): heap-exhausted, for a recycle.
    expect(await ask(render(1))).toMatchObject({ type: 'heap-exhausted', taskId: 1 })
  }, 30_000)

  it('after a trap the thread is poisoned: every later render is refused, never retried in it', async () => {
    const ask = await thread('trap')
    expect(await ask(render(1))).toMatchObject({
      type: 'fatal',
      taskId: 1,
      error: 'RuntimeError: unreachable'
    })
    expect(await ask(render(2))).toMatchObject({
      type: 'fatal',
      taskId: 2,
      error: 'raster module poisoned'
    })
  }, 30_000)
})

describe('the thread heap caps (budget.ts threadOptions, PR0b §f)', () => {
  // Real worker_threads with the production options. The code strings are test-only threads
  // (`eval: true` is banned in the shipped sources, not here).
  function run(code: string): Promise<{ message?: unknown; error?: Error; exit: number }> {
    return new Promise((resolve) => {
      const w = new Worker(code, { eval: true, ...threadOptions() })
      let message: unknown
      let error: Error | undefined
      w.on('message', (m) => (message = m))
      w.on('error', (e) => (error = e))
      w.on('exit', (exit) => resolve({ message, error, exit }))
    })
  }

  it('applies them: the thread sees a heap limit of old + young', async () => {
    const r = await run(
      "const v = require('v8'); require('worker_threads').parentPort.postMessage(v.getHeapStatistics().heap_size_limit); process.exit(0)"
    )
    const limitMb = (r.message as number) / 2 ** 20
    expect(limitMb).toBe(
      THREAD_RESOURCE_LIMITS.maxOldGenerationSizeMb +
        THREAD_RESOURCE_LIMITS.maxYoungGenerationSizeMb
    )
  })

  it('a runaway of small objects is ERR_WORKER_OUT_OF_MEMORY, a thread OOM to the coordinator; this process lives', async () => {
    const r = await run('const a = []; for (;;) a.push({ x: new Array(64).fill(Math.random()) })')
    expect(r.error).toMatchObject({ code: 'ERR_WORKER_OUT_OF_MEMORY' })
    expect(isThreadOom(r.error)).toBe(true)
    expect(r.exit).toBe(1)
    // The parent (here: vitest; in production: the utility process) carries on.
    const again = await run("require('worker_threads').parentPort.postMessage('alive')")
    expect(again.message).toBe('alive')
  }, 30_000)

  it('does NOT contain a runaway that grows one big array: V8 aborts the whole process, and says so on stderr', () => {
    // In a child process, since this one would die. Node lets a capped worker overrun its limit by
    // only 16 MiB while it stops it; an array's backing store grows by ~50 % at a time, so past the
    // cap one allocation asks for far more and V8 aborts (exit 134 / SIGABRT). The supervisor must
    // recognise exactly this output (supervisor.ts isV8FatalOom).
    const script = [
      "const { Worker } = require('node:worker_threads')",
      'const resourceLimits = JSON.parse(process.argv[1])',
      "new Worker('const a = []; for (let i = 0; ; i++) a.push(i + 0.5)', { eval: true, resourceLimits })",
      "  .on('error', (e) => { console.log('contained:' + e.code); process.exit(0) })"
    ].join('\n')
    const r = spawnSync(process.execPath, ['-e', script, JSON.stringify(THREAD_RESOURCE_LIMITS)], {
      encoding: 'utf8',
      timeout: 60_000
    })
    expect(r.stdout).not.toContain('contained:')
    expect(r.status === 0).toBe(false)
    expect(isV8FatalOom(r.stderr)).toBe(true)
  }, 90_000)

  it('does not cap the WASM memories or buffers the engines need (they live outside the V8 heap)', async () => {
    // 512 MiB of WASM memory (more than the whole heap cap) plus 256 MiB of ArrayBuffers, and a
    // 20,000-frame recursion on the default 4 MB stack.
    const r = await run(
      [
        'const keep = []',
        'for (let i = 0; i < 2; i++) { const b = new ArrayBuffer(128 * 2 ** 20); new Uint8Array(b).fill(1); keep.push(b) }',
        'const m = new WebAssembly.Memory({ initial: 8192 })',
        'new Uint8Array(m.buffer).fill(2)',
        'const depth = (n) => (n ? 1 + depth(n - 1) : 0)',
        "require('worker_threads').parentPort.postMessage({ wasmMb: m.buffer.byteLength / 2 ** 20, buffers: keep.length, depth: depth(20000) })",
        'process.exit(0)'
      ].join('\n')
    )
    expect(r.error).toBeUndefined()
    expect(r.message).toEqual({ wasmMb: 512, buffers: 2, depth: 20000 })
  }, 30_000)
})
