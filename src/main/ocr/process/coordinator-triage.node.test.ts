// The coordinator's triage path with scripted threads (DESIGN.md §3.4.1, §3.3.4): requests are
// answered in chunks, one PDFium task at a time with the renders; a whole-document triage waits
// for the page count; a chunk that kills the raster thread is retried page by page and a page
// that kills it twice is reported failed; close drops a triage in flight; every message the
// renderer gets is valid protocol.

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  parseFromOcr,
  type FromOcr,
  type PageResult,
  type TriagePage
} from '../../../shared/ocr/protocol'
import { Coordinator, TRIAGE_CHUNK, triageWatchdogMs } from './coordinator'
import type { FromRaster } from './thread-messages'
import {
  FakePort,
  INIT,
  harness,
  recognized,
  rendered,
  settle,
  triaged,
  type HarnessOptions
} from '../test-utils/fake-threads'

let live: Coordinator[] = []
afterEach(() => {
  for (const c of live) c.dispose()
  live = []
  vi.useRealTimers()
})

async function start(opts: HarnessOptions = {}) {
  const h = harness(opts)
  const c = new Coordinator(h.deps)
  live.push(c)
  h.parent.send(INIT)
  const port = new FakePort()
  h.parent.send({ port: {} }, [port])
  await settle()
  return { h, c, port }
}

type Triaged = { src: string; pages: TriagePage[]; done: boolean }
const triagedOf = (port: FakePort): Triaged[] => port.of('triaged') as Triaged[]
const indices = (port: FakePort): number[] =>
  triagedOf(port).flatMap((t) => t.pages.map((p) => p.index))

async function open(port: FakePort, src: string): Promise<void> {
  port.send({ open: { src, bytes: new Uint8Array(64).fill(0x25) } })
  await settle()
}

const job = (jobId: string, pages: number[]): unknown => ({
  recognize: {
    jobId,
    src: 's1',
    pages: pages.map((index) => ({ index, userUnit: 1, width: 612, height: 792 })),
    opts: { langs: ['eng'], renderDpi: 72 }
  }
})

describe('triage requests (§3.4.1)', () => {
  it('triages every page in chunks and says when it is done', async () => {
    const { h, port } = await start({ pageCount: () => 70 })
    await open(port, 's1')
    port.send({ triage: { src: 's1' } })
    await settle(200)
    expect(indices(port)).toEqual(Array.from({ length: 70 }, (_, i) => i))
    const msgs = triagedOf(port)
    expect(msgs.map((m) => m.done)).toEqual([false, false, true])
    expect(h.rasters[0].triages.map((t) => t.pages.length)).toEqual([TRIAGE_CHUNK, TRIAGE_CHUNK, 6])
    for (const m of port.sent) expect(() => parseFromOcr(m as FromOcr)).not.toThrow()
  })

  it('triages only the pages asked for, in request order', async () => {
    const { port } = await start()
    await open(port, 's1')
    port.send({ triage: { src: 's1', pages: [7, 2, 9] } })
    await settle(60)
    expect(indices(port)).toEqual([7, 2, 9])
    expect(triagedOf(port).at(-1)?.done).toBe(true)
  })

  it('answers an empty page list at once and refuses a source that is not open', async () => {
    const { h, port } = await start()
    port.send({ triage: { src: 'nope' } })
    await open(port, 's1')
    port.send({ triage: { src: 's1', pages: [] } })
    await settle()
    expect(port.of('error')).toEqual([expect.objectContaining({ code: 'not-open', src: 'nope' })])
    expect(triagedOf(port)).toEqual([{ src: 's1', pages: [], done: true }])
    expect(h.rasters[0].triages).toHaveLength(0)
  })

  it('a whole-document triage sent before the page count arrives waits for it', async () => {
    const { h, port } = await start({ pageCount: () => 3 })
    port.send({ open: { src: 's1', bytes: new Uint8Array(64).fill(0x25) } })
    port.send({ triage: { src: 's1' } })
    await settle(60)
    expect(port.of('opened')).toEqual([{ src: 's1', pageCount: 3 }])
    expect(indices(port)).toEqual([0, 1, 2])
    expect(h.rasters).toHaveLength(1)
  })

  it('a document with no pages is done at once', async () => {
    const { port } = await start({ pageCount: () => 0 })
    await open(port, 's1')
    port.send({ triage: { src: 's1' } })
    await settle()
    expect(triagedOf(port)).toEqual([{ src: 's1', pages: [], done: true }])
  })

  it('keeps one PDFium task at a time: a render waits for the triage chunk in flight', async () => {
    let release: (() => void) | null = null
    const { h, port } = await start({
      rasterTriage: (msg, thread) => {
        release = () => thread.reply(triaged(msg, thread))
        return 'hang'
      }
    })
    await open(port, 's1')
    port.send({ triage: { src: 's1', pages: [0] } })
    port.send({
      recognize: {
        jobId: 'j1',
        src: 's1',
        pages: [{ index: 0, userUnit: 1, width: 612, height: 792 }],
        opts: { langs: ['eng'], renderDpi: 72 }
      }
    })
    await settle()
    expect(h.rasters[0].renders).toHaveLength(0)
    release!()
    await settle(60)
    expect(indices(port)).toEqual([0])
    expect(h.rasters[0].renders).toHaveLength(1)
    expect(port.of('jobDone')).toEqual([expect.objectContaining({ jobId: 'j1', done: 1 })])
  })

  it('retries a chunk that killed the thread page by page; a page that kills it twice fails', async () => {
    const BAD = 5
    const { h, port } = await start({
      pageCount: () => 8,
      rasterTriage: (msg, thread) => (msg.pages.includes(BAD) ? 'crash' : triaged(msg, thread))
    })
    await open(port, 's1')
    port.send({ triage: { src: 's1' } })
    await settle(400)
    const pages = triagedOf(port).flatMap((t) => t.pages)
    expect(pages.map((p) => p.index).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    const bad = pages.find((p) => p.index === BAD)!
    expect(bad).toMatchObject({ pageClass: null, failure: 'raster-crash', renderDpi: null })
    expect(pages.filter((p) => p.index !== BAD).every((p) => p.pageClass === 'scanned')).toBe(true)
    expect(triagedOf(port).at(-1)?.done).toBe(true)
    // One crash on the whole chunk, then BAD alone twice: three threads died, the others answered
    // one page per message.
    const sizes = h.rasters.flatMap((r) => r.triages.map((t) => t.pages.length))
    expect(sizes[0]).toBe(8)
    expect(sizes.slice(1).every((n) => n === 1)).toBe(true)
    expect(h.rasters.length).toBe(4)
    for (const m of port.sent) expect(() => parseFromOcr(m as FromOcr)).not.toThrow()
  })

  it('a hung triage chunk is retired by the watchdog and its pages go again', async () => {
    expect(triageWatchdogMs(TRIAGE_CHUNK)).toBe(47_000)
    vi.useFakeTimers()
    let calls = 0
    const { h, port } = await start({
      rasterTriage: (msg, thread) => (calls++ === 0 ? 'hang' : triaged(msg, thread))
    })
    await open(port, 's1')
    port.send({ triage: { src: 's1', pages: [0, 1] } })
    await settle()
    expect(triagedOf(port)).toEqual([])
    await vi.advanceTimersByTimeAsync(triageWatchdogMs(2) + 1)
    await settle(60)
    expect(h.rasters[0].terminated).toBe(true)
    // Retried one page at a time (it cannot tell which page hung), each answered once.
    expect(indices(port).sort()).toEqual([0, 1])
  })
  it('drops the triage of a source closed while its chunk was in flight', async () => {
    let release: (() => void) | null = null
    const { port } = await start({
      rasterTriage: (msg, thread) => {
        release = () => thread.reply(triaged(msg, thread))
        return 'hang'
      }
    })
    await open(port, 's1')
    port.send({ triage: { src: 's1', pages: [0, 1] } })
    await settle()
    port.send({ close: 's1' })
    release!()
    await settle(60)
    expect(triagedOf(port)).toEqual([])
  })

  it('keeps one PDFium task at a time: a triage waits for the render in flight', async () => {
    let release: (() => void) | null = null
    const { h, port } = await start({
      raster: (msg, thread) => {
        release = () => thread.reply(rendered(msg, thread))
        return 'hang'
      }
    })
    await open(port, 's1')
    port.send(job('j1', [0]))
    await settle()
    expect(h.rasters[0].renders).toHaveLength(1)
    port.send({ triage: { src: 's1', pages: [3] } })
    await settle()
    expect(h.rasters[0].triages).toHaveLength(0)
    release!()
    await settle(60)
    expect(h.rasters[0].triages).toHaveLength(1)
    expect(indices(port)).toEqual([3])
    expect(triagedOf(port).at(-1)?.done).toBe(true)
  })

  it('renders go before background triage when both wait for the thread', async () => {
    let release: (() => void) | null = null
    const { h, port } = await start({
      raster: (msg, thread) => {
        if (msg.index !== 0) return rendered(msg, thread)
        release = () => thread.reply(rendered(msg, thread))
        return 'hang'
      }
    })
    await open(port, 's1')
    port.send(job('j1', [0, 1]))
    await settle()
    port.send({ triage: { src: 's1', pages: [5] } })
    await settle()
    release!()
    await settle(80)
    const order = h.rasters[0].received
      .filter((m) => m.type === 'render' || m.type === 'triage')
      .map((m) => (m.type === 'render' ? `render ${m.index}` : 'triage'))
    expect(order).toEqual(['render 0', 'render 1', 'triage'])
    expect(indices(port)).toEqual([5])
  })

  it('a chunk whose thread died on an open queued ahead of it goes again (retireRaster)', async () => {
    let opens = 0
    const { h, port } = await start({
      rasterOpen: (src) => (src === 's2' && opens++ === 0 ? 'crash' : undefined)
    })
    await open(port, 's1')
    // Same tick: the counted open of s2 is in flight AHEAD of the s1 chunk when the thread dies,
    // so the open is blamed and the chunk was never reached.
    port.send({ open: { src: 's2', bytes: new Uint8Array(64).fill(0x25) } })
    port.send({ triage: { src: 's1', pages: [0, 1] } })
    await settle(120)
    expect(h.rasters[0].triages).toHaveLength(1)
    expect(h.rasters[0].terminated).toBe(true)
    expect(port.of('error')).toEqual([expect.objectContaining({ code: 'open-failed', src: 's2' })])
    expect(indices(port)).toEqual([0, 1])
    expect(triagedOf(port).at(-1)?.done).toBe(true)
    // The chunk went again as a whole (it was never charged): one message on the next thread.
    expect(h.rasters[1].triages.map((t) => t.pages)).toEqual([[0, 1]])
  })

  it('eviction spares a source with a triage pending, which still completes', async () => {
    let release: (() => void) | null = null
    let calls = 0
    const { port } = await start({
      budgets: { sourceBudget: 150 },
      rasterTriage: (msg, thread) => {
        if (calls++ > 0) return triaged(msg, thread)
        release = () => thread.reply(triaged(msg, thread))
        return 'hang'
      }
    })
    await open(port, 's1')
    port.send({ triage: { src: 's1', pages: [0] } })
    await settle()
    await open(port, 's2')
    await open(port, 's3') // 3 × 64 bytes > 150: one source must go, and it is not s1
    expect(port.of('evicted')).toEqual([{ src: 's2' }])
    release!()
    await settle(60)
    expect(triagedOf(port)).toEqual([
      { src: 's1', pages: [expect.objectContaining({ index: 0 })], done: true }
    ])
  })

  it('one source whose pages all kill PDFium is cut off; it cannot take OCR down', async () => {
    const { h, port } = await start({
      pageCount: () => 40,
      rasterTriage: (msg, thread) => (msg.src === 's1' ? 'crash' : triaged(msg, thread))
    })
    await open(port, 's1')
    port.send({ triage: { src: 's1' } })
    await settle(600)
    const pages = triagedOf(port).flatMap((t) => t.pages)
    expect(pages.map((p) => p.index).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 40 }, (_, i) => i)
    )
    expect(pages.every((p) => p.failure === 'raster-crash')).toBe(true)
    expect(triagedOf(port).at(-1)?.done).toBe(true)
    // The 32-page chunk, then pages 0 and 1 twice each alone; the other 38 never reach PDFium.
    expect(h.rasters).toHaveLength(5)
    expect(h.rasters.flatMap((r) => r.triages.map((t) => t.pages.length))).toEqual([32, 1, 1, 1, 1])
    expect(h.parent.of('fatal')).toEqual([])
    // A new request for it is answered at once; another source still triages normally.
    port.send({ triage: { src: 's1', pages: [7] } })
    await open(port, 's2')
    port.send({ triage: { src: 's2', pages: [0] } })
    await settle(60)
    const tail = triagedOf(port).slice(-2)
    expect(tail[0]).toEqual({
      src: 's1',
      pages: [expect.objectContaining({ index: 7, failure: 'raster-crash' })],
      done: true
    })
    expect(tail[1]).toEqual({
      src: 's2',
      pages: [expect.objectContaining({ index: 0, pageClass: 'scanned' })],
      done: true
    })
    for (const m of port.sent) expect(() => parseFromOcr(m as FromOcr)).not.toThrow()
  })

  it('a dying multi-page chunk is not a fatal of its own: two such documents leave OCR up', async () => {
    // Each costs 4 charged deaths (2 pages × 2): 8 < 10. Counting the two chunk deaths too would
    // reach the process-wide limit and give up on every source.
    const { h, port } = await start({
      pageCount: () => 5,
      rasterTriage: (msg, thread) => (msg.src === 's3' ? triaged(msg, thread) : 'crash')
    })
    for (const s of ['s1', 's2', 's3']) await open(port, s)
    for (const s of ['s1', 's2', 's3']) port.send({ triage: { src: s } })
    await settle(1000)
    expect(h.parent.of('fatal')).toEqual([])
    const s3 = triagedOf(port).filter((t) => t.src === 's3')
    expect(s3.flatMap((t) => t.pages.map((p) => p.pageClass))).toEqual(Array(5).fill('scanned'))
    expect(s3.at(-1)?.done).toBe(true)
  })

  it('giving up answers every pending triage with done: true', async () => {
    const { h, port } = await start({
      pageCount: () => 3,
      rasterTriage: (msg, thread) => (msg.src === 's4' ? triaged(msg, thread) : 'crash')
    })
    for (const s of ['s1', 's2', 's3', 's4']) await open(port, s)
    for (const s of ['s1', 's2', 's3', 's4']) port.send({ triage: { src: s } })
    await settle(1200)
    expect(h.parent.of('fatal')).toEqual([
      expect.objectContaining({ code: 'init', message: 'raster thread keeps crashing' })
    ])
    for (const s of ['s1', 's2', 's3', 's4']) {
      const mine = triagedOf(port).filter((t) => t.src === s)
      expect(mine.at(-1)?.done, s).toBe(true)
      expect(mine.flatMap((t) => t.pages.map((p) => p.index)).sort(), s).toEqual([0, 1, 2])
    }
    for (const m of port.sent) expect(() => parseFromOcr(m as FromOcr)).not.toThrow()
  })

  it('a page the port would reject becomes a failure, not a lost batch', async () => {
    const { port } = await start({
      rasterTriage: (msg, thread) => {
        const out = triaged(msg, thread) as Extract<FromRaster, { type: 'triaged' }>
        out.pages[1] = { ...out.pages[1], effectiveDpi: 0 } // rounds to 0: outside (0, 1e6]
        out.pages[2] = { ...out.pages[2], renderDpi: 0 }
        out.pages.splice(3, 1) // and one the thread left out
        out.pages.push({ ...out.pages[0], index: 99 }) // and one nobody asked for
        return out
      }
    })
    await open(port, 's1')
    port.send({ triage: { src: 's1', pages: [0, 1, 2, 3, 4] } })
    await settle(60)
    const msgs = triagedOf(port)
    expect(msgs).toHaveLength(1)
    expect(() => parseFromOcr({ triaged: msgs[0] })).not.toThrow()
    expect(msgs[0].pages.map((p) => [p.index, p.pageClass, p.failure])).toEqual([
      [0, 'scanned', undefined],
      [1, null, 'render'],
      [2, null, 'render'],
      [3, null, 'render'],
      [4, 'scanned', undefined]
    ])
    expect(msgs[0].done).toBe(true)
  })

  it('a source PDFium cannot open for triage ends with open-failed', async () => {
    const { port } = await start({
      rasterTriage: (msg, thread) => ({
        type: 'triage-failed',
        taskId: msg.taskId,
        pdfiumError: 3,
        tripwire: thread.tripwire
      })
    })
    await open(port, 's1')
    port.send({ triage: { src: 's1', pages: [0] } })
    await settle(60)
    expect(port.of('error')).toEqual([expect.objectContaining({ code: 'open-failed', src: 's1' })])
    expect(triagedOf(port)).toEqual([])
  })
})

describe('triage activity (the idle kill)', () => {
  it('tells main while triage requests are open', async () => {
    let release: (() => void) | null = null
    const { h, port } = await start({
      rasterTriage: (msg, thread) => {
        release = () => thread.reply(triaged(msg, thread))
        return 'hang'
      }
    })
    await open(port, 's1')
    port.send({ triage: { src: 's1', pages: [0] } })
    await settle()
    expect(h.parent.of('activity')).toEqual([{ busy: false, done: 0, total: 0, triage: true }])
    release!()
    await settle(60)
    expect(h.parent.of('activity').at(-1)).toEqual({
      busy: false,
      done: 0,
      total: 0,
      triage: false
    })
    // Closing a source with triage still open ends it too.
    port.send({ triage: { src: 's1', pages: [1] } })
    await settle()
    expect(h.parent.of('activity').at(-1)).toMatchObject({ triage: true })
    port.send({ close: 's1' })
    await settle()
    expect(h.parent.of('activity').at(-1)).toMatchObject({ triage: false })
  })
})

// ---------------------------------------------------------------------------------------------
// Triage meets recognition (PR4b × PR5).

/** A triage script that answers each page with `verdict(index)` on top of the default page. */
const verdicts =
  (verdict: (index: number) => Partial<TriagePage>): HarnessOptions['rasterTriage'] =>
  (msg, thread) => {
    const out = triaged(msg, thread) as Extract<FromRaster, { type: 'triaged' }>
    out.pages = out.pages.map((p) => ({ ...p, ...verdict(p.index) }))
    return out
  }

/** The verdicts the refusal tests use: 1 protected, 2 a refused JPX, 3 over the pixel caps. */
const REFUSING = verdicts((i): Partial<TriagePage> => {
  if (i === 0) return { pageClass: 'near-scanned' }
  if (i === 1) return { pageClass: 'protected', renderDpi: null, raster: null }
  if (i === 2) return { refused: 'jpx-subsampled' }
  if (i === 3)
    return {
      pageClass: null,
      failure: 'too-large',
      renderDpi: null,
      raster: null,
      effectiveDpi: null,
      bitsPerPixel: null
    }
  return {}
})

type Result = { jobId: string; src: string; index: number; page: PageResult }
const resultsOf = (port: FakePort): Map<number, PageResult> =>
  new Map((port.of('result') as Result[]).map((r) => [r.index, r.page]))

describe('triage results drive recognition', () => {
  it('stamps each recognised page with its triage class; unclassified pages stay `scanned`', async () => {
    const { port } = await start({
      rasterTriage: verdicts((i) =>
        i === 0
          ? { pageClass: 'near-scanned' }
          : i === 1
            ? { pageClass: 'mixed' }
            : { pageClass: null, failure: 'render' }
      )
    })
    await open(port, 's1')
    port.send({ triage: { src: 's1', pages: [0, 1, 2] } })
    await settle(60)
    port.send(job('j1', [0, 1, 2, 4]))
    await settle(120)
    const r = resultsOf(port)
    expect(r.get(0)?.recognition?.pageClass).toBe('near-scanned')
    expect(r.get(1)?.recognition?.pageClass).toBe('mixed')
    // Triage could not classify 2, and never saw 4: both are treated as scans.
    expect(r.get(2)?.recognition?.pageClass).toBe('scanned')
    expect(r.get(4)?.recognition?.pageClass).toBe('scanned')
    for (const m of port.sent) expect(() => parseFromOcr(m as FromOcr)).not.toThrow()
  })

  it('answers pages triage refused without a render or the engine', async () => {
    const { h, port } = await start({ rasterTriage: REFUSING })
    await open(port, 's1')
    port.send({ triage: { src: 's1', pages: [0, 1, 2, 3] } })
    await settle(60)
    port.send(job('j1', [0, 1, 2, 3]))
    await settle(120)
    const r = resultsOf(port)
    expect(r.get(1)).toEqual({
      status: 'skipped-protected',
      renderDpi: null,
      raster: null,
      recognition: null
    })
    expect(r.get(2)).toMatchObject({ status: 'failed', reason: 'image-format', recognition: null })
    expect(r.get(3)).toMatchObject({
      status: 'too-large',
      reason: 'page-too-large',
      recognition: null
    })
    expect(r.get(0)).toMatchObject({ status: 'ok' })
    // Only page 0 reached PDFium's renderer and an engine.
    expect(h.rasters.flatMap((t) => t.renders.map((m) => m.index))).toEqual([0])
    expect(h.recognizers.flatMap((t) => t.jobs)).toHaveLength(1)
    expect(port.of('jobDone')).toEqual([
      { jobId: 'j1', done: 2, failed: 2, cancelled: false } // skipped-protected counts as done
    ])
    for (const m of port.sent) expect(() => parseFromOcr(m as FromOcr)).not.toThrow()
  })

  it('refuses queued pages when triage answers after the recognize request', async () => {
    let release: (() => void) | null = null
    const { h, port } = await start({
      rasterTriage: (msg, thread) => {
        release = () => thread.reply(REFUSING!(msg, thread) as FromRaster)
        return 'hang'
      }
    })
    await open(port, 's1')
    port.send({ triage: { src: 's1', pages: [0, 1, 2, 3] } })
    await settle()
    // The thread is busy with the chunk: these pages wait in the queue.
    port.send(job('j1', [1, 2, 3, 5]))
    await settle()
    expect(h.rasters[0].renders).toHaveLength(0)
    release!()
    await settle(120)
    const r = resultsOf(port)
    expect(r.get(1)?.status).toBe('skipped-protected')
    expect(r.get(2)).toMatchObject({ status: 'failed', reason: 'image-format' })
    expect(r.get(3)).toMatchObject({ status: 'too-large', reason: 'page-too-large' })
    expect(r.get(5)?.status).toBe('ok')
    expect(h.rasters[0].renders.map((m) => m.index)).toEqual([5])
  })

  it('drops the words of a page triage refuses while it is at the engine', async () => {
    let finish: (() => void) | null = null
    let release: (() => void) | null = null
    const { h, port } = await start({
      recognize: (msg, thread) => {
        finish = () => thread.reply(recognized(msg, thread))
        return 'hang'
      },
      rasterTriage: (msg, thread) => {
        release = () => thread.reply(REFUSING!(msg, thread) as FromRaster)
        return 'hang'
      }
    })
    await open(port, 's1')
    // Renders go first: page 1 is rendered and at the engine before triage reaches the thread.
    port.send(job('j1', [1]))
    port.send({ triage: { src: 's1', pages: [1] } })
    await settle(60)
    expect(h.recognizers.flatMap((t) => t.jobs)).toHaveLength(1)
    release!()
    await settle(60)
    expect(port.of('result')).toEqual([])
    finish!()
    await settle(60)
    expect(resultsOf(port).get(1)).toMatchObject({
      status: 'skipped-protected',
      recognition: null
    })
  })
})
