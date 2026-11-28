// The coordinator's triage path with scripted threads (DESIGN.md §3.4.1, §3.3.4): requests are
// answered in chunks, one PDFium task at a time with the renders; a whole-document triage waits
// for the page count; a chunk that kills the raster thread is retried page by page and a page
// that kills it twice is reported failed; close drops a triage in flight; every message the
// renderer gets is valid protocol.

import { afterEach, describe, expect, it, vi } from 'vitest'

import { parseFromOcr, type FromOcr, type TriagePage } from '../../../shared/ocr/protocol'
import { Coordinator, TRIAGE_CHUNK, triageWatchdogMs } from './coordinator'
import {
  FakePort,
  INIT,
  harness,
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
