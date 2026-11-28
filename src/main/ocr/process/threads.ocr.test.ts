// Tier 1: the REAL raster AND recognize thread entries (bundled the way `?modulePath` bundles them,
// under the production heap caps) with the real engine from node_modules, under the coordinator:
// the posted WebAssembly.Module reaching the recognize thread, transferred grey bitmaps recognised
// and mapped into the page's display frame, on a /Rotate 0 and a /Rotate 90 page with text drawn
// upright in that frame, and every thread's tripwire counter at 0. (The selftest suite covers the
// clean300 page exactly; this one pins the frame of a rotated page.)

import { readFile } from 'node:fs/promises'
import { availableParallelism, totalmem } from 'node:os'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib'

import { ENGINE_ID } from '../../../shared/ocr/engine/tess-core'
import type { FromOcr, Heartbeat, PageResult } from '../../../shared/ocr/protocol'
import { unpack } from '../../../shared/ocr/types'
import { threadOptions } from './budget'
import { Coordinator } from './coordinator'
import { ENGINE_DATA } from './engine-manifest'
import { loadEngine } from './engine-node'
import { bundleEntry, type Bundled } from '../test-utils/bundle'
import { FakeParent, FakePort, INIT } from '../test-utils/fake-threads'
import { nodeModulesEnginePaths } from '../test-utils/engine-harness'
import { PDFIUM_WASM_PATH } from '../test-utils/pdfium-node'

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url))

let raster: Bundled
let recognize: Bundled
let parent: FakeParent
let port: FakePort
let coordinator: Coordinator

function waitFor<T>(pred: () => T | undefined, ms = 60_000): Promise<T> {
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
  raster = await bundleEntry(here('./raster-thread.ts'), {
    alias: { '@embedpdf/pdfium': here('../../../../node_modules/@embedpdf/pdfium/dist/index.cjs') }
  })
  recognize = await bundleEntry(here('./recognize-thread.ts'))
  parent = new FakeParent()
  coordinator = new Coordinator({
    parent,
    spawnRaster: () => new Worker(raster.file, threadOptions()),
    spawnRecognize: () => new Worker(recognize.file, threadOptions()),
    loadPdfium: async () => WebAssembly.compile(await readFile(PDFIUM_WASM_PATH)),
    loadEngine,
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
  parent.send({ init: { ...INIT.init, paths: nodeModulesEnginePaths() } })
  port = new FakePort()
  parent.send({ port: {} }, [port])
})

afterAll(() => {
  coordinator?.dispose()
  raster?.dispose()
  recognize?.dispose()
})

/** Where the text's baseline starts in the DISPLAY frame (pt, bottom-left), both pages. */
const AT = { x: 72, y: 500 }
const TEXT = ['HARBOUR', 'OFFICE']
const SIZE = 36

describe('real raster and recognize threads, real engine', () => {
  it('recognises upright text on a /Rotate 0 and a /Rotate 90 page, in each page display frame', async () => {
    const doc = await PDFDocument.create()
    const font = await doc.embedFont(StandardFonts.Helvetica)
    const p0 = doc.addPage([612, 792])
    p0.drawText(TEXT.join(' '), { x: AT.x, y: AT.y, size: SIZE, font })
    // /Rotate 90 turns the page clockwise for display: display (vx, vy) is user (612 − vy, vx), and
    // text drawn turned +90° in user space reads upright on screen.
    const p1 = doc.addPage([612, 792])
    p1.setRotation(degrees(90))
    p1.drawText(TEXT.join(' '), { x: 612 - AT.y, y: AT.x, size: SIZE, font, rotate: degrees(90) })
    port.send({ open: { src: 'doc', bytes: await doc.save() } })
    await waitFor(() => sent().find((m) => 'opened' in m))
    port.send({
      recognize: {
        jobId: 'j1',
        src: 'doc',
        pages: [
          { index: 0, userUnit: 1, width: 612, height: 792 },
          { index: 1, userUnit: 1, width: 792, height: 612 }
        ],
        opts: { langs: ['eng'], renderDpi: 100 }
      }
    })
    await waitFor(() => sent().find((m) => 'jobDone' in m))
    const pages = sent()
      .filter((m): m is Extract<FromOcr, { result: unknown }> => 'result' in m)
      .map((m) => m.result)
      .sort((a, b) => a.index - b.index)
      .map((r) => r.page) as PageResult[]
    expect(pages.map((p) => p.raster)).toEqual([
      { width: 850, height: 1100 },
      { width: 1100, height: 850 }
    ])
    for (const p of pages) {
      expect(p.status).toBe('ok')
      const rec = p.recognition!
      expect(rec).toMatchObject({ engineId: ENGINE_ID, renderDpi: 100, langs: ['eng'] })
      // Provenance: the manifest's .gz hash, the one CACHE_INFO and configHash use.
      expect(rec.dataHashes).toEqual({ eng: ENGINE_DATA.eng.sha256 })
      const lines = unpack(rec).lines
      expect(lines.flatMap((l) => l.words.map((w) => w.t))).toEqual(TEXT)
      const [line] = lines
      expect(line.angle).toBe(0)
      // Helvetica caps at 36 pt; the size estimate stays within the line-box clamp.
      expect(line.size).toBeGreaterThan(SIZE * 0.6)
      expect(line.size).toBeLessThan(SIZE * 1.5)
      const w0 = line.words[0]
      expect(Math.abs(w0.x - AT.x), `x of ${w0.t}`).toBeLessThan(4)
      expect(Math.abs(w0.y - AT.y), `y of ${w0.t}`).toBeLessThan(4)
    }
    expect(sent().find((m) => 'jobDone' in m)).toEqual({
      jobDone: { jobId: 'j1', done: 2, failed: 0, cancelled: false }
    })
  })

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
