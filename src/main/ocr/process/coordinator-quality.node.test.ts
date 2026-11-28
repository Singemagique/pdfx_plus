// The coordinator's PR6 paths with scripted threads (DESIGN.md §3.4.2–§3.4.6): each page renders
// at the DPI triage chose (or the request's override), with NO_SMOOTHIMAGE for a 1-bit image at
// ≤ 1.5× native and the near-scanned text mask; a first result that asks for the adaptive pass is
// rendered again at the higher DPI and recognised with its geometry, the better result kept, and
// any failure in that phase ends the page with the first result; the result is mapped through the
// copy's affine, carries the orientation, the skew and `rotateBy`; near-scanned native boxes drop
// the OCR words on them.

import { afterEach, describe, expect, it } from 'vitest'

import { parseFromOcr, type FromOcr, type PageResult } from '../../../shared/ocr/protocol'
import type { TriagePage } from '../../../shared/ocr/triage'
import { unpack } from '../../../shared/ocr/types'
import { Coordinator } from './coordinator'
import { NO_SMOOTH_1BIT, renderFlagsFor } from './page-plan'
import {
  FakePort,
  INIT,
  harness,
  outcomeOf,
  recognized,
  rendered,
  settle,
  type HarnessOptions,
  type TriageMsg
} from '../test-utils/fake-threads'
import type { FromRaster } from './thread-messages'

let live: Coordinator[] = []
afterEach(() => {
  for (const c of live) c.dispose()
  live = []
})

async function start(opts: HarnessOptions = {}) {
  const h = harness(opts)
  const c = new Coordinator(h.deps)
  live.push(c)
  h.parent.send(INIT)
  const port = new FakePort()
  h.parent.send({ port: {} }, [port])
  await settle()
  port.send({ open: { src: 's1', bytes: new Uint8Array(64).fill(0x25) } })
  await settle()
  return { h, c, port }
}

const triageWith =
  (page: Partial<TriagePage>) =>
  (msg: TriageMsg): FromRaster => ({
    type: 'triaged',
    taskId: msg.taskId,
    pages: msg.pages.map((index) => ({
      index,
      pageClass: 'scanned' as const,
      renderDpi: 400,
      raster: { width: 3400, height: 4400 },
      effectiveDpi: 400,
      bitsPerPixel: 8,
      imageOrigin: false,
      ...page
    })),
    heap: 0,
    tripwire: 0
  })

async function triageThenRecognize(
  port: FakePort,
  page: { width: number; height: number; editRotation?: 0 | 90 | 180 | 270 } = {
    width: 612,
    height: 792
  },
  opts: Record<string, unknown> = {}
): Promise<PageResult> {
  port.send({ triage: { src: 's1', pages: [0] } })
  await settle(60)
  port.send({
    recognize: {
      jobId: 'j1',
      src: 's1',
      pages: [{ index: 0, userUnit: 1, ...page }],
      opts: { langs: ['eng'], ...opts }
    }
  })
  await settle(200)
  const r = port.of('result') as { page: PageResult }[]
  for (const m of port.sent) expect(() => parseFromOcr(m as FromOcr)).not.toThrow()
  return r[0].page
}

describe('render DPI and flags from triage (§3.4.2, §3.4.3)', () => {
  it('renders at the DPI triage chose; the request override wins', async () => {
    const { h, port } = await start({ rasterTriage: triageWith({ renderDpi: 400 }) })
    const p = await triageThenRecognize(port)
    expect(h.rasters[0].renders.map((r) => r.dpi)).toEqual([400])
    expect(p.renderDpi).toBe(400)
    const b = await start({ rasterTriage: triageWith({ renderDpi: 400 }) })
    await triageThenRecognize(b.port, undefined, { renderDpi: 150 })
    expect(b.h.rasters[0].renders.map((r) => r.dpi)).toEqual([150])
  })

  it('renders at 300 when triage has not answered', async () => {
    const { h, port } = await start()
    port.send({
      recognize: {
        jobId: 'j1',
        src: 's1',
        pages: [{ index: 0, userUnit: 1, width: 612, height: 792 }],
        opts: { langs: ['eng'] }
      }
    })
    await settle(200)
    expect(h.rasters[0].renders.map((r) => r.dpi)).toEqual([300])
  })

  it('renders with the flags page-plan gives (NO_SMOOTHIMAGE only if the A/B had picked it)', async () => {
    const on = (t: Partial<TriagePage>): number | undefined =>
      renderFlagsFor(t as TriagePage, t.renderDpi!) || undefined
    const cases: [Partial<TriagePage>, number | undefined][] = [
      [
        { bitsPerPixel: 1, effectiveDpi: 300, renderDpi: 300 },
        on({ bitsPerPixel: 1, effectiveDpi: 300, renderDpi: 300 })
      ],
      [
        { bitsPerPixel: 1, effectiveDpi: 200, renderDpi: 300 },
        on({ bitsPerPixel: 1, effectiveDpi: 200, renderDpi: 300 })
      ],
      [{ bitsPerPixel: 1, effectiveDpi: 150, renderDpi: 300 }, undefined],
      [{ bitsPerPixel: 8, effectiveDpi: 300, renderDpi: 300 }, undefined]
    ]
    for (const [t, flags] of cases) {
      const { h, port } = await start({ rasterTriage: triageWith(t) })
      await triageThenRecognize(port)
      expect(h.rasters[0].renders[0].flags, JSON.stringify(t)).toBe(flags)
    }
    // The A/B kept smoothing on (page-plan.ts), so no page gets the flag today.
    expect(NO_SMOOTH_1BIT).toBe(false)
  })

  it('masks the native text of a near-scanned page, and drops OCR words lying on it', async () => {
    // The fake engine reads one word "scanned" in the middle of the raster (fake-threads.ts).
    const { h, port } = await start({
      rasterTriage: triageWith({
        pageClass: 'near-scanned',
        renderDpi: 300,
        nativeWords: [{ t: 'scanned', x0: 0, y0: 0, x1: 612, y1: 792 }]
      })
    })
    const p = await triageThenRecognize(port)
    expect(h.rasters[0].renders[0].maskText).toBe(true)
    expect(p.status).toBe('no-text')
    const b = await start({ rasterTriage: triageWith({ renderDpi: 300 }) })
    const q = await triageThenRecognize(b.port)
    expect(b.h.rasters[0].renders[0].maskText).toBeUndefined()
    expect(q.status).toBe('ok')
  })
})

/** A page small enough that the harness's pixel caps never bind at 500 DPI. */
const SMALL = { width: 200, height: 200 }

describe('the adaptive pass (§3.4.3)', () => {
  it('renders again at the requested DPI, recognises with the first geometry, keeps the better', async () => {
    const { h, port } = await start({
      rasterTriage: triageWith({ renderDpi: 300 }),
      recognize: (m, t) => {
        const base = recognized(m, t)
        if (base.type !== 'result') return base
        if (!m.reuse)
          return {
            ...base,
            result: outcomeOf(base.result.raw, {
              adaptive: { dpi: 450, measured: 13.3, script: 'xheight' },
              plan: { quarterTurns: 0, skewDeg: 1.5 },
              recipe: { psm: 3, thresholding: 2 }
            })
          }
        // A better second read: a higher-confidence word.
        const raw = base.result.raw
        raw.lines[0].words[0].conf = 99
        return { ...base, result: outcomeOf(raw, { plan: m.reuse.plan }) }
      }
    })
    const p = await triageThenRecognize(port, SMALL)
    expect(h.rasters[0].renders.map((r) => r.dpi)).toEqual([300, 450])
    const jobs = h.recognizers.flatMap((r) => r.jobs)
    expect(jobs.map((j) => j.reuse ?? null)).toEqual([
      null,
      { plan: { quarterTurns: 0, skewDeg: 1.5 }, recipe: { psm: 3, thresholding: 2 } }
    ])
    expect(p.renderDpi).toBe(450)
    expect(p.recognition!.skewDeg).toBe(1.5)
    expect(port.of('jobDone')).toEqual([{ jobId: 'j1', done: 1, failed: 0, cancelled: false }])
  })

  it('keeps the first result when the second scores lower, or when its render fails', async () => {
    for (const failing of [false, true]) {
      const { h, port } = await start({
        rasterTriage: triageWith({ renderDpi: 300 }),
        raster: (m, t) =>
          failing && m.dpi > 300
            ? {
                type: 'render-failed',
                taskId: m.taskId,
                status: 'failed',
                reason: 'render',
                heap: 0,
                tripwire: 0
              }
            : rendered(m, t),
        recognize: (m, t) => {
          const base = recognized(m, t)
          if (base.type !== 'result') return base
          if (m.reuse) {
            base.result.raw.lines[0].words[0].conf = 10
            return base
          }
          return {
            ...base,
            result: outcomeOf(base.result.raw, {
              adaptive: { dpi: 500, measured: 12, script: 'xheight' }
            })
          }
        }
      })
      const p = await triageThenRecognize(port, SMALL)
      expect(h.rasters[0].renders.map((r) => r.dpi)).toEqual([300, 500])
      expect(p.status, String(failing)).toBe('ok')
      expect(p.renderDpi).toBe(300)
      expect(unpack(p.recognition!).lines[0].words[0].conf).toBe(92)
    }
  })

  it('skips a re-render that would gain under 5% (caps, or a request already near 600 DPI)', async () => {
    const { h, port } = await start({
      rasterTriage: triageWith({ renderDpi: 590 }),
      recognize: (m, t) => {
        const base = recognized(m, t)
        if (base.type !== 'result') return base
        return {
          ...base,
          result: outcomeOf(base.result.raw, {
            adaptive: { dpi: 900, measured: 10, script: 'xheight' }
          })
        }
      }
    })
    await triageThenRecognize(port, SMALL)
    expect(h.rasters[0].renders.map((r) => r.dpi)).toEqual([590])
  })
})

describe('orientation and rotation Δ (§3.4.5)', () => {
  it('reports the detected orientation and offers rotateBy = (θ − r_edit) mod 360 when not 0', async () => {
    const turned =
      (theta: 0 | 90 | 180 | 270): HarnessOptions['recognize'] =>
      (m, t) => {
        const base = recognized(m, t)
        if (base.type !== 'result') return base
        return {
          ...base,
          result: outcomeOf(base.result.raw, {
            orientation: theta,
            plan: { quarterTurns: (theta / 90) as 0 | 1 | 2 | 3, skewDeg: 0 }
          })
        }
      }
    const cases: [0 | 90 | 180 | 270, 0 | 90 | 180 | 270, number | undefined][] = [
      [90, 0, 90],
      [90, 90, undefined],
      [180, 90, 90],
      [0, 270, 90],
      [0, 0, undefined]
    ]
    for (const [theta, edit, by] of cases) {
      const { port } = await start({
        rasterTriage: triageWith({ renderDpi: 300 }),
        recognize: turned(theta)
      })
      const p = await triageThenRecognize(port, { width: 612, height: 792, editRotation: edit })
      expect(p.recognition!.orientation).toBe(theta)
      expect(p.rotateBy, `${theta} − ${edit}`).toBe(by)
    }
  })

  it('maps through the copy’s affine: a quarter-turned copy lands back on the page', async () => {
    // The fake engine reads a word in the middle of the (turned) copy; mapped through a 90° turn
    // it must still lie on the page.
    const { port } = await start({
      rasterTriage: triageWith({ renderDpi: 100 }),
      recognize: (m, t) => {
        const base = recognized(m, t)
        if (base.type !== 'result') return base
        return {
          ...base,
          result: outcomeOf(base.result.raw, {
            orientation: 90,
            plan: { quarterTurns: 1, skewDeg: 0 },
            // copy px (h × w) → raster px (w × h): the quarter-turn inverse of geometry.ts.
            toSource: [0, -1, 1, 0, 0, m.height]
          })
        }
      }
    })
    const p = await triageThenRecognize(port)
    const [line] = unpack(p.recognition!).lines
    // The copy's +x is the raster's −y (up): text reading bottom to top, as on rot90page.
    expect(line.angle).toBeCloseTo(Math.PI / 2, 6)
    const w = line.words[0]
    expect(w.x).toBeGreaterThan(0)
    expect(w.x).toBeLessThan(612)
    expect(w.y).toBeGreaterThan(0)
    expect(w.y).toBeLessThan(792)
  })
})
