// The coordinator's scheduler and failure policy with scripted threads (DESIGN.md §3.3.3–§3.3.6):
// work order, render-ahead, solo big pages, recycling, cancel, close by source token, the raster
// failure policy (RuntimeError → respawn → re-queue once → failed), the silent-blank guard, the
// recognize watchdog and OOM halving, the byte-budgeted LRU, progress throttling and the tripwire
// totals in the heartbeat.

import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { FromOcr, Heartbeat, PageResult } from '../../../shared/ocr/protocol'
import { concurrency, recognizeWatchdogMs, rasterWatchdogMs } from './budget'
import { Coordinator, isOomShaped } from './coordinator'
import {
  FakePort,
  INIT,
  LIMITS,
  harness,
  recognized,
  rendered,
  settle,
  type Harness,
  type HarnessOptions
} from '../test-utils/fake-threads'

const PAGE = { userUnit: 1, width: 612, height: 792 }
const bytes = (n = 64): Uint8Array => new Uint8Array(n).fill(0x25)
const pages = (...idx: number[]): Array<typeof PAGE & { index: number }> =>
  idx.map((index) => ({ index, ...PAGE }))

let live: Coordinator[] = []

afterEach(() => {
  for (const c of live) c.dispose()
  live = []
  vi.useRealTimers()
})

async function start(opts: HarnessOptions = {}): Promise<{
  h: Harness
  c: Coordinator
  port: FakePort
}> {
  const h = harness(opts)
  const c = new Coordinator(h.deps)
  live.push(c)
  h.parent.send(INIT)
  const port = new FakePort()
  h.parent.send({ port: {} }, [port])
  await settle()
  return { h, c, port }
}

function results(
  port: FakePort
): Array<{ jobId: string; src: string; index: number; page: PageResult }> {
  return port.of('result') as Array<{ jobId: string; src: string; index: number; page: PageResult }>
}

function jobDone(
  port: FakePort
): Array<{ jobId: string; done: number; failed: number; cancelled: boolean }> {
  return port.of('jobDone') as Array<{
    jobId: string
    done: number
    failed: number
    cancelled: boolean
  }>
}

function errors(port: FakePort): Array<{ code: string; src?: string; jobId?: string }> {
  return port.of('error') as Array<{ code: string; src?: string; jobId?: string }>
}

async function open(port: FakePort, src: string, n = 64): Promise<void> {
  port.send({ open: { src, bytes: bytes(n) } })
  await settle()
}

function recognize(
  port: FakePort,
  jobId: string,
  src: string,
  idx: number[],
  renderDpi = 72
): void {
  port.send({
    recognize: { jobId, src, pages: pages(...idx), opts: { langs: ['eng'], renderDpi } }
  })
}

describe('budgets', () => {
  const b = { perWorker: 256 * 2 ** 20, baseline: 96 * 2 ** 20, maxThreads: 4 }
  const GiB = 2 ** 30

  it('applies the §3.3.3 formula', () => {
    // 16 GiB, 8 GiB free, 24 cores: min(4, 22, (4 GiB − 96 MiB) / 256 MiB = 15) = 4.
    expect(concurrency({ totalmem: 16 * GiB, availableMemory: 8 * GiB, cpus: 24 }, LIMITS, b)).toBe(
      4
    )
    // 4 GiB machine: min(1 GiB, 1 GiB) − 96 MiB → 3 threads.
    expect(concurrency({ totalmem: 4 * GiB, availableMemory: 2 * GiB, cpus: 8 }, LIMITS, b)).toBe(3)
    // Memory-starved: never below 1.
    expect(concurrency({ totalmem: 1 * GiB, availableMemory: 0.1 * GiB, cpus: 8 }, LIMITS, b)).toBe(
      1
    )
    // A 4-core laptop leaves two cores to the UI and the raster thread.
    expect(concurrency({ totalmem: 16 * GiB, availableMemory: 8 * GiB, cpus: 4 }, LIMITS, b)).toBe(
      2
    )
  })

  it('halves on battery, drops to 1 when throttled, and divides by the OOM divisor', () => {
    const sys = { totalmem: 16 * GiB, availableMemory: 8 * GiB, cpus: 24 }
    expect(concurrency(sys, { ...LIMITS, onBattery: true }, b)).toBe(2)
    expect(concurrency(sys, { ...LIMITS, thermal: 'serious' }, b)).toBe(1)
    expect(concurrency(sys, { ...LIMITS, thermal: 'critical' }, b)).toBe(1)
    expect(concurrency(sys, { ...LIMITS, speedLimit: 79 }, b)).toBe(1)
    expect(concurrency(sys, { ...LIMITS, divisor: 2 }, b)).toBe(2)
    expect(concurrency(sys, LIMITS, b, 4)).toBe(1)
    // PER_WORKER is injectable: a larger budget lowers n.
    expect(concurrency(sys, LIMITS, { ...b, perWorker: 2 * GiB })).toBe(1)
  })

  it('sizes the watchdogs from the page area', () => {
    expect(recognizeWatchdogMs(8.7e6)).toBe(130_500)
    expect(recognizeWatchdogMs(1e6)).toBe(60_000)
    expect(recognizeWatchdogMs(36e6)).toBe(180_000)
    expect(rasterWatchdogMs(8.7e6)).toBe(17_400)
    expect(rasterWatchdogMs(1e6)).toBe(15_000)
    expect(rasterWatchdogMs(36e6)).toBe(60_000)
  })

  it('recognises OOM-shaped errors', () => {
    expect(isOomShaped('RangeError', 'Invalid array length')).toBe(true)
    expect(isOomShaped('RuntimeError', 'Aborted(Cannot enlarge memory arrays)')).toBe(true)
    expect(isOomShaped('Error', 'Array buffer allocation failed')).toBe(true)
    expect(isOomShaped('RuntimeError', 'unreachable')).toBe(false)
  })
})

describe('the happy path', () => {
  it('opens a source, recognizes its pages and reports in protocol shape', async () => {
    const { h, port } = await start()
    expect(h.parent.of('ready')).toEqual([
      { tripwire: 0, electronNet: ['fetch', 'request', 'resolveHost', 'isOnline'] }
    ])
    await open(port, 's1')
    expect(port.of('opened')).toEqual([{ src: 's1', pageCount: 10 }])
    recognize(port, 'j1', 's1', [0, 1, 2])
    await settle()
    expect(
      results(port)
        .map((r) => r.index)
        .sort()
    ).toEqual([0, 1, 2])
    for (const r of results(port)) {
      expect(r.page.status).toBe('ok')
      expect(r.page.raster).toEqual({ width: 612, height: 792 })
      expect(r.page.recognition?.stub).toBe(true)
    }
    expect(jobDone(port)).toEqual([{ jobId: 'j1', done: 3, failed: 0, cancelled: false }])
    // The recognize threads got the coordinator's compiled module, once each.
    for (const r of h.recognizers) expect(r.initModule).toBeInstanceOf(WebAssembly.Module)
    // Source bytes reach the raster thread as a SharedArrayBuffer (survives a respawn).
    const openMsg = h.rasters[0].received.find((m) => m.type === 'open')
    expect(openMsg && 'data' in openMsg && openMsg.data).toBeInstanceOf(SharedArrayBuffer)
    // Every message the renderer got is valid protocol.
    const { parseFromOcr } = await import('../../../shared/ocr/protocol')
    for (const m of port.sent) expect(() => parseFromOcr(m as FromOcr)).not.toThrow()
  })

  it('answers bad and not-yet-supported messages without acting on them', async () => {
    const { h, port } = await start()
    port.send({ open: { src: '../etc/passwd', bytes: bytes() } })
    port.send({ triage: { src: 's1' } })
    port.send({ recognize: { jobId: 'j', src: 'nope', pages: pages(0), opts: { langs: ['eng'] } } })
    await settle()
    expect(errors(port).map((e) => e.code)).toEqual(['bad-message', 'unsupported', 'not-open'])
    expect(h.rasters).toHaveLength(0)
  })

  it('refuses a duplicate source token, a duplicate job id and a source over 1.5 GB', async () => {
    const { port } = await start({ raster: () => 'hang' })
    await open(port, 's1')
    await open(port, 's1')
    recognize(port, 'j1', 's1', [0])
    recognize(port, 'j1', 's1', [1])
    const huge = new Uint8Array(8)
    Object.defineProperty(huge, 'byteLength', { value: 1.5 * 2 ** 30 + 1 })
    port.send({ open: { src: 'big', bytes: huge } })
    await settle()
    expect(errors(port)).toEqual([
      expect.objectContaining({ code: 'duplicate', src: 's1' }),
      expect.objectContaining({ code: 'duplicate', jobId: 'j1' }),
      expect.objectContaining({ code: 'too-large', src: 'big' })
    ])
  })
})

describe('work order and pipelining', () => {
  it('renders the focused page, then the rest of its source, then other jobs', async () => {
    const { h, port } = await start({ threads: 1 })
    await open(port, 'a')
    await open(port, 'b')
    recognize(port, 'ja', 'a', [0, 1])
    // a:0 is already rendering (the raster thread was idle). Then the user scrolls to b's page 7
    // and b's job arrives: everything still queued is reordered around the focus.
    port.send({ focus: { src: 'b', index: 7 } })
    recognize(port, 'jb', 'b', [5, 6, 7])
    await settle(60)
    const order = h.rasters[0].renders.map((r) => `${r.src}:${r.index}`)
    expect(order).toEqual(['a:0', 'b:7', 'b:5', 'b:6', 'a:1'])
  })

  it('moves the focus mid-job', async () => {
    const { h, port } = await start({ threads: 1 })
    await open(port, 'a')
    recognize(port, 'ja', 'a', [0, 1, 2, 3, 4, 5])
    port.send({ focus: { src: 'a', index: 4 } })
    await settle(80)
    const order = h.rasters[0].renders.map((r) => r.index)
    expect(order).toEqual([0, 4, 1, 2, 3, 5])
  })

  it('renders at most n + 1 pages ahead of the recognize threads', async () => {
    const { h, c, port } = await start({ threads: 1, recognize: () => 'hang' })
    await open(port, 's')
    recognize(port, 'j', 's', [0, 1, 2, 3, 4, 5])
    await settle()
    // n = 1: one page recognizing, two rendered and waiting; the rest stay queued.
    expect(h.rasters[0].renders).toHaveLength(3)
    expect(c.snapshot()).toMatchObject({ recognizing: 1, rendered: 2, queued: 3 })
  })

  it('runs a page over 12 MP alone and recycles its thread afterwards', async () => {
    let maxBusy = 0
    const busy = new Set<number>()
    const { h, port } = await start({
      threads: 3,
      raster: (m, t) => rendered(m, t, m.index === 1 ? { w: 4000, h: 3500 } : { w: 100, h: 100 }),
      recognize: (m, t) => {
        busy.add(m.taskId)
        maxBusy = Math.max(maxBusy, busy.size)
        if (m.width === 4000) expect(busy.size).toBe(1)
        queueMicrotask(() => busy.delete(m.taskId))
        return recognized(m, t)
      }
    })
    await open(port, 's')
    recognize(port, 'j', 's', [0, 1, 2, 3])
    await settle(60)
    expect(results(port)).toHaveLength(4)
    const bigThread = h.recognizers.find((r) => r.jobs.some((j) => j.width === 4000))
    expect(bigThread?.terminated).toBe(true)
  })

  it('recycles a recognize thread after the page budget', async () => {
    const { h, port } = await start({ threads: 1, budgets: { recyclePages: 2 } })
    await open(port, 's')
    recognize(port, 'j', 's', [0, 1, 2, 3, 4])
    await settle(80)
    expect(results(port)).toHaveLength(5)
    expect(h.recognizers.map((r) => r.jobs.length)).toEqual([2, 2, 1])
    expect(h.recognizers.slice(0, 2).every((r) => r.terminated)).toBe(true)
  })
})

describe('cancel and close (reconcile by source token)', () => {
  it('cancel drops queued pages and terminates busy recognize threads', async () => {
    const { h, c, port } = await start({ threads: 2, recognize: () => 'hang' })
    await open(port, 's')
    recognize(port, 'j', 's', [0, 1, 2, 3, 4, 5, 6, 7])
    await settle()
    const busy = h.recognizers.filter((r) => r.jobs.length > 0)
    expect(busy).toHaveLength(2)
    port.send({ cancel: 'j' })
    await settle()
    expect(busy.every((r) => r.terminated)).toBe(true)
    expect(jobDone(port)).toEqual([{ jobId: 'j', done: 0, failed: 0, cancelled: true }])
    expect(c.snapshot()).toMatchObject({ queued: 0, rendered: 0, recognizing: 0, jobs: [] })
    expect(results(port)).toHaveLength(0)
    // A cancel for a job that already finished (or never existed) is a no-op.
    port.send({ cancel: 'j' })
    port.send({ cancel: 'other' })
    await settle()
    expect(jobDone(port)).toHaveLength(1)
    expect(errors(port)).toHaveLength(0)
  })

  it('closing source A leaves source B and its job alone', async () => {
    let releaseB: (() => void) | null = null
    const { h, c, port } = await start({
      threads: 1,
      recognize: (m, t) => {
        // Hold B's first page so B is mid-job when A closes.
        if (!releaseB) {
          releaseB = () => t.reply(recognized(m, t))
          return 'hang'
        }
        return recognized(m, t)
      }
    })
    await open(port, 'B')
    await open(port, 'A')
    recognize(port, 'jb', 'B', [0, 1])
    recognize(port, 'ja', 'A', [0, 1, 2])
    await settle()
    port.send({ close: 'A' })
    await settle()
    expect(jobDone(port)).toEqual([{ jobId: 'ja', done: 0, failed: 0, cancelled: true }])
    expect(h.rasters[0].closed).toEqual(['A'])
    expect(c.snapshot().sources).toEqual(['B'])
    releaseB!()
    await settle(60)
    expect(jobDone(port)).toContainEqual({ jobId: 'jb', done: 2, failed: 0, cancelled: false })
    expect(results(port).every((r) => r.src === 'B')).toBe(true)
    // A is gone for good under that token.
    recognize(port, 'ja2', 'A', [0])
    await settle()
    expect(errors(port)).toContainEqual(expect.objectContaining({ code: 'not-open', src: 'A' }))
  })

  it('keeps two tokens for equal bytes independent (the sha256 is not the key)', async () => {
    const { c, port } = await start({ raster: () => 'hang' })
    await open(port, 'first')
    await open(port, 'second')
    port.send({ close: 'first' })
    await settle()
    expect(c.snapshot().sources).toEqual(['second'])
    // Closing an unknown or already-closed token is a no-op, not an error.
    port.send({ close: 'first' })
    port.send({ close: 'never' })
    await settle()
    expect(errors(port)).toEqual([])
  })

  it('a new renderer port voids the old session', async () => {
    const { h, c, port } = await start({ recognize: () => 'hang' })
    await open(port, 's')
    recognize(port, 'j', 's', [0, 1])
    await settle()
    const port2 = new FakePort()
    h.parent.send({ port: {} }, [port2])
    await settle()
    expect(port.closed).toBe(true)
    expect(port2.started).toBe(true)
    expect(c.snapshot()).toMatchObject({ sources: [], jobs: [] })
    // The old port's late messages are ignored.
    port.emit('message', { data: { open: { src: 'x', bytes: bytes() } } })
    await settle()
    expect(c.snapshot().sources).toEqual([])
  })

  it('the renderer port closing (window gone) ends the session', async () => {
    const { c, port } = await start({ recognize: () => 'hang' })
    await open(port, 's')
    recognize(port, 'j', 's', [0])
    await settle()
    port.emit('close')
    await settle()
    expect(c.snapshot()).toMatchObject({ sources: [], jobs: [], recognizing: 0 })
  })
})

describe('raster failure policy (§3.3.4)', () => {
  it('RuntimeError → respawn → re-queue once → failed; the page behind it carries on', async () => {
    const { h, port } = await start({
      threads: 1,
      raster: (m, t) =>
        m.index === 1
          ? { type: 'fatal', taskId: m.taskId, error: 'RuntimeError: unreachable', tripwire: 0 }
          : rendered(m, t)
    })
    await open(port, 's')
    recognize(port, 'j', 's', [1, 2])
    await settle(80)
    // Thread 1 trapped on page 1 → thread 2 retried page 1 and trapped → thread 3 rendered page 2.
    expect(h.rasters).toHaveLength(3)
    expect(h.rasters.slice(0, 2).every((r) => r.terminated)).toBe(true)
    expect(h.rasters[1].renders.map((r) => r.index)).toEqual([1])
    const byIndex = Object.fromEntries(results(port).map((r) => [r.index, r.page]))
    expect(byIndex[1]).toMatchObject({
      status: 'failed',
      reason: 'raster-crash',
      recognition: null
    })
    expect(byIndex[2].status).toBe('ok')
    // The respawned thread got every source re-registered (lazily opened, no second `opened`).
    expect(h.rasters[1].received.filter((m) => m.type === 'open')).toEqual([
      expect.objectContaining({ src: 's', count: false })
    ])
    expect(port.of('opened')).toHaveLength(1)
  })

  it('a thread that dies (error event) is the same failure', async () => {
    let n = 0
    const { h, port } = await start({ raster: (m, t) => (n++ === 0 ? 'crash' : rendered(m, t)) })
    await open(port, 's')
    recognize(port, 'j', 's', [0])
    await settle(60)
    expect(h.rasters).toHaveLength(2)
    expect(results(port)[0].page.status).toBe('ok')
  })

  it('a render watchdog expiry respawns and retries once, then fails the page', async () => {
    vi.useFakeTimers()
    const { h, port } = await start({ raster: () => 'hang' })
    await open(port, 's')
    recognize(port, 'j', 's', [0])
    await settle()
    expect(h.rasters).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(15_001)
    await settle()
    expect(h.rasters).toHaveLength(2)
    expect(h.rasters[0].terminated).toBe(true)
    await vi.advanceTimersByTimeAsync(15_001)
    await settle()
    expect(results(port)[0].page).toMatchObject({ status: 'failed', reason: 'raster-crash' })
  })

  it('silent-blank guard: a heap-exhausted render never reaches a recognize thread', async () => {
    const { h, port } = await start({
      raster: (m, t) => ({ type: 'heap-exhausted', taskId: m.taskId, heap: t.heap, tripwire: 0 })
    })
    await open(port, 's')
    recognize(port, 'j', 's', [0])
    await settle(60)
    // Retried once in a fresh (recycled) raster thread, then too-large; both threads recycled.
    expect(h.rasters).toHaveLength(2)
    expect(h.rasters.map((r) => r.renders.length)).toEqual([1, 1])
    expect(h.rasters[0].terminated && h.rasters[1].terminated).toBe(true)
    expect(results(port)[0].page).toMatchObject({
      status: 'too-large',
      reason: 'heap',
      raster: null
    })
    expect(h.recognizers.flatMap((r) => r.jobs)).toEqual([])
  })

  it('passes render failures through as page statuses', async () => {
    const { port } = await start({
      raster: (m, t) => ({
        type: 'render-failed',
        taskId: m.taskId,
        status: 'failed',
        reason: 'frame-mismatch',
        heap: t.heap,
        tripwire: 0
      })
    })
    await open(port, 's')
    recognize(port, 'j', 's', [0])
    await settle()
    expect(results(port)[0].page).toMatchObject({ status: 'failed', reason: 'frame-mismatch' })
    expect(jobDone(port)).toEqual([{ jobId: 'j', done: 0, failed: 1, cancelled: false }])
  })

  it('recycles the raster thread between documents once its heap is past the threshold', async () => {
    const { h, port } = await start({
      threads: 1,
      budgets: { rasterRecycleHeap: 100 * 2 ** 20 },
      raster: (m, t) => {
        t.heap = 200 * 2 ** 20
        return rendered(m, t)
      }
    })
    await open(port, 'a')
    await open(port, 'b')
    recognize(port, 'ja', 'a', [0, 1])
    recognize(port, 'jb', 'b', [0])
    await settle(80)
    expect(results(port)).toHaveLength(3)
    // Page a:1 followed a:0 on the same document (no recycle); b:0 got a fresh thread.
    expect(h.rasters.map((r) => r.renders.map((x) => `${x.src}:${x.index}`))).toEqual([
      ['a:0', 'a:1'],
      ['b:0']
    ])
  })

  it('gives up (fatal to main) instead of respawning a raster thread that cannot start', async () => {
    const h0 = harness()
    let spawned = 0
    const c = new Coordinator({
      ...h0.deps,
      spawnRaster: () => {
        spawned++
        const w = new EventEmitter() as EventEmitter & {
          postMessage(m: unknown): void
          terminate(): void
        }
        // Dies on init, before ever saying ready (a missing or corrupt module, say).
        w.postMessage = (m: unknown) => {
          if ((m as { type: string }).type === 'init')
            queueMicrotask(() => {
              w.emit('error', new Error('Cannot find module'))
              w.emit('exit', 1)
            })
        }
        w.terminate = () => {}
        return w as never
      }
    })
    live.push(c)
    h0.parent.send(INIT)
    const port = new FakePort()
    h0.parent.send({ port: {} }, [port])
    await settle()
    port.send({ open: { src: 's', bytes: bytes() } })
    recognize(port, 'j', 's', [0, 1])
    await settle(80)
    expect(spawned).toBe(3)
    expect(h0.parent.of('fatal')).toEqual([
      { code: 'init', message: 'raster thread failed to start' }
    ])
    expect(results(port).map((r) => r.page.status)).toEqual(['failed', 'failed'])
  })

  it('reports a source PDFium cannot open and forgets it', async () => {
    const h0 = harness()
    const c = new Coordinator({
      ...h0.deps,
      spawnRaster: () => {
        const r = h0.deps.spawnRaster() as unknown as {
          reply(m: unknown): void
          postMessage(m: unknown): void
        }
        const post = r.postMessage.bind(r)
        r.postMessage = (m: unknown) => {
          const msg = m as { type: string; src?: string; count?: boolean }
          if (msg.type === 'open' && msg.count)
            r.reply({ type: 'open-failed', src: msg.src, pdfiumError: 4, tripwire: 0 })
          else post(m)
        }
        return r as never
      }
    })
    live.push(c)
    h0.parent.send(INIT)
    const port = new FakePort()
    h0.parent.send({ port: {} }, [port])
    await settle()
    await open(port, 'locked')
    expect(errors(port)).toEqual([
      { code: 'open-failed', message: 'password required', src: 'locked' }
    ])
    expect(c.snapshot().sources).toEqual([])
  })
})

describe('recognize failure policy (§3.3.4)', () => {
  it('a trap respawns the thread and re-renders the page once, then fails it', async () => {
    const { h, port } = await start({
      threads: 1,
      recognize: (m, t) =>
        m.taskId === 1
          ? {
              type: 'error',
              taskId: m.taskId,
              name: 'RuntimeError',
              message: 'unreachable',
              tripwire: 0
            }
          : recognized(m, t)
    })
    await open(port, 's')
    recognize(port, 'j', 's', [0, 1])
    await settle(80)
    const byIndex = Object.fromEntries(results(port).map((r) => [r.index, r.page]))
    expect(byIndex[0]).toMatchObject({ status: 'failed', reason: 'recognize-crash' })
    expect(byIndex[1].status).toBe('ok')
    // Page 0 was rendered twice: the bitmap went with the dead thread.
    expect(h.rasters[0].renders.filter((r) => r.index === 0)).toHaveLength(2)
  })

  it('an OOM-shaped failure halves the concurrency for the session', async () => {
    let first = true
    const { c, port } = await start({
      threads: 4,
      recognize: (m, t) => {
        if (first) {
          first = false
          return {
            type: 'error',
            taskId: m.taskId,
            name: 'RangeError',
            message: 'Array buffer allocation failed',
            tripwire: 0
          }
        }
        return recognized(m, t)
      }
    })
    expect(c.snapshot().concurrency).toBe(4)
    await open(port, 's')
    recognize(port, 'j', 's', [0, 1, 2])
    await settle(80)
    expect(c.snapshot().concurrency).toBe(2)
    expect(results(port).every((r) => r.page.status === 'ok')).toBe(true)
  })

  it('the watchdog terminates a stuck thread and marks the page timeout', async () => {
    vi.useFakeTimers()
    const { h, port } = await start({ recognize: () => 'hang' })
    await open(port, 's')
    recognize(port, 'j', 's', [0])
    await settle()
    await vi.advanceTimersByTimeAsync(60_001)
    await settle()
    expect(h.recognizers[0].terminated).toBe(true)
    expect(results(port)[0].page).toMatchObject({ status: 'timeout', reason: 'watchdog' })
  })
})

describe('memory: the byte-budgeted LRU', () => {
  it('evicts the least-recently used idle source past the budget, never a busy one', async () => {
    const { c, port } = await start({ budgets: { sourceBudget: 250 }, recognize: () => 'hang' })
    await open(port, 'old', 100)
    await open(port, 'busy', 100)
    recognize(port, 'j', 'busy', [0])
    await settle()
    await open(port, 'new', 100)
    expect(port.of('evicted')).toEqual([{ src: 'old' }])
    expect(c.snapshot().sources.sort()).toEqual(['busy', 'new'])
  })

  it('still opens one source larger than the whole budget, alone', async () => {
    const { c, port } = await start({ budgets: { sourceBudget: 100 } })
    await open(port, 'a', 50)
    await open(port, 'huge', 500)
    expect(port.of('evicted')).toEqual([{ src: 'a' }])
    expect(c.snapshot().sources).toEqual(['huge'])
    expect(port.of('opened')).toContainEqual({ src: 'huge', pageCount: 10 })
  })
})

describe('progress, activity and heartbeat', () => {
  it('throttles progress to ≤ 10 Hz per job and reports activity to main', async () => {
    vi.useFakeTimers()
    const { h, port } = await start({ threads: 4 })
    await open(port, 's')
    recognize(
      port,
      'j',
      's',
      Array.from({ length: 40 }, (_, i) => i)
    )
    for (let i = 0; i < 60; i++) await settle(5)
    const burst = port.of('progress').length
    // All 40 pages finished inside one 100 ms window: one leading progress event, the rest wait.
    expect(burst).toBeLessThanOrEqual(2)
    await vi.advanceTimersByTimeAsync(150)
    expect(jobDone(port)).toEqual([{ jobId: 'j', done: 40, failed: 0, cancelled: false }])
    const act = h.parent.of('activity') as Array<{ busy: boolean; done: number; total: number }>
    expect(act[0]).toMatchObject({ busy: true, total: 40 })
    expect(act.at(-1)).toEqual({ busy: false, done: 0, total: 0 })
  })

  it('sums the tripwire counters of the process and of every thread, retired ones included', async () => {
    const { h, c, port } = await start({
      threads: 1,
      budgets: { recyclePages: 1 },
      tripwire: () => 1,
      recognize: (m, t) => {
        t.tripwire = 2
        return recognized(m, t)
      },
      raster: (m, t) => {
        t.tripwire = 3
        return rendered(m, t)
      }
    })
    await open(port, 's')
    recognize(port, 'j', 's', [0, 1])
    await settle(60)
    h.parent.send({ heartbeat: {} })
    const hb = (h.parent.of('heartbeat') as Heartbeat[]).at(-1)!
    // Two recognize threads (recycled after one page each) reported 2 each.
    expect(hb.tripwire).toEqual({ process: 1, raster: 3, recognize: 4 })
    expect(hb.threads).toEqual({ raster: 1, recognize: 0 })
    expect(c.snapshot().jobs).toEqual([])
  })

  it('shuts down on request', async () => {
    const { h, c } = await start()
    h.parent.send({ shutdown: {} })
    expect(h.exitCodes).toEqual([0])
    expect(c.snapshot().rasterLive).toBe(false)
  })
})
