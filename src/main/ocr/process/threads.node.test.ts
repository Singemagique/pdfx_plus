// The REAL thread entries, bundled the way `?modulePath` bundles them and run as worker_threads
// under the coordinator: PDFium WASM inside a worker_thread opening a SharedArrayBuffer source with
// FPDF_LoadCustomDocument (PR0 only ran PDFium on a main thread; DESIGN.md §3.3.1 step 3 names this
// as PR4a's first test), the posted WebAssembly.Module reaching the recognize thread, transferred
// grey bitmaps, and every thread's tripwire counter at 0.

import { readFile } from 'node:fs/promises'
import { availableParallelism, totalmem } from 'node:os'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PDFDocument, degrees, rgb } from 'pdf-lib'

import type { FromOcr, Heartbeat, PageResult } from '../../../shared/ocr/protocol'
import { Coordinator } from './coordinator'
import { STUB_ENGINE_WASM } from './stub-engine'
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
    spawnRaster: () => new Worker(raster.file),
    spawnRecognize: () => new Worker(recognize.file),
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
