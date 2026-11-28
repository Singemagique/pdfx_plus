// Test-only fakes for the coordinator: scripted raster and recognize threads, the utility process's
// parentPort and a renderer MessagePort. Replies are delivered on a microtask, like a real thread's.

import { EventEmitter } from 'node:events'

import type { CoordinatorDeps, ParentLike, PortLike, WorkerLike } from '../process/coordinator'
import type { FromRaster, FromRecognize, ToRaster, ToRecognize } from '../process/thread-messages'
import type { Budgets } from '../process/budget'

const later = (fn: () => void): void => {
  void Promise.resolve().then(fn)
}

/** Let every queued microtask (and the replies they schedule) run. */
export async function settle(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve()
}

abstract class FakeWorker<In, Out> extends EventEmitter implements WorkerLike {
  readonly received: In[] = []
  terminated = false
  tripwire = 0

  postMessage(msg: unknown): void {
    if (this.terminated) return
    this.received.push(msg as In)
    this.handle(msg as In)
  }

  terminate(): Promise<number> {
    if (!this.terminated) {
      this.terminated = true
      later(() => this.emit('exit', 1))
    }
    return Promise.resolve(1)
  }

  /** Reply from the thread (on a microtask). */
  reply(msg: Out): void {
    later(() => {
      if (!this.terminated) this.emit('message', msg)
    })
  }

  /** The thread dies on its own (uncaught error). */
  crash(err = new Error('thread crashed')): void {
    later(() => {
      if (this.terminated) return
      this.terminated = true
      this.emit('error', err)
      this.emit('exit', 1)
    })
  }

  protected abstract handle(msg: In): void
}

export type RenderMsg = Extract<ToRaster, { type: 'render' }>
/** What a scripted raster thread does with one render: a reply, or 'hang' (never answers). */
export type RasterScript = (msg: RenderMsg, thread: FakeRaster) => FromRaster | 'hang' | 'crash'

export class FakeRaster extends FakeWorker<ToRaster, FromRaster> {
  heap = 20 * 2 ** 20
  readonly renders: RenderMsg[] = []
  readonly closed: string[] = []

  constructor(
    private readonly script: RasterScript,
    private readonly pageCount: (src: string) => number
  ) {
    super()
  }

  protected handle(msg: ToRaster): void {
    if (msg.type === 'init') this.reply({ type: 'ready', tripwire: this.tripwire })
    else if (msg.type === 'open') {
      if (msg.count)
        this.reply({
          type: 'opened',
          src: msg.src,
          pageCount: this.pageCount(msg.src),
          tripwire: this.tripwire
        })
    } else if (msg.type === 'close') this.closed.push(msg.src)
    else if (msg.type === 'render') {
      this.renders.push(msg)
      const out = this.script(msg, this)
      if (out === 'crash') this.crash(new Error('raster thread died'))
      else if (out !== 'hang') this.reply(out)
    }
  }
}

/** A successful render at the request's DPI: a white page with a black band (w × h grey). */
export function rendered(
  msg: RenderMsg,
  thread: FakeRaster,
  px?: { w: number; h: number }
): FromRaster {
  const w = px?.w ?? Math.max(1, Math.round((msg.frame.width * msg.dpi) / 72))
  const h = px?.h ?? Math.max(1, Math.round((msg.frame.height * msg.dpi) / 72))
  const data = new Uint8Array(w * h).fill(255)
  data.fill(0, 0, Math.min(data.length, w * Math.ceil(h / 10)))
  return {
    type: 'rendered',
    taskId: msg.taskId,
    width: w,
    height: h,
    dpi: msg.dpi,
    data: data.buffer,
    heap: thread.heap,
    tripwire: thread.tripwire
  }
}

export type RecognizeMsg = Extract<ToRecognize, { type: 'recognize' }>
export type RecognizeScript = (
  msg: RecognizeMsg,
  thread: FakeRecognizer
) => FromRecognize | 'hang' | 'crash'

export class FakeRecognizer extends FakeWorker<ToRecognize, FromRecognize> {
  readonly jobs: RecognizeMsg[] = []
  initModule: WebAssembly.Module | null = null

  constructor(private readonly script: RecognizeScript) {
    super()
  }

  protected handle(msg: ToRecognize): void {
    if (msg.type === 'init') {
      this.initModule = msg.engine
      this.reply({ type: 'ready', tripwire: this.tripwire })
      return
    }
    this.jobs.push(msg)
    const out = this.script(msg, this)
    if (out === 'crash') this.crash(new Error('recognize thread died'))
    else if (out !== 'hang') this.reply(out)
  }
}

export function recognized(msg: RecognizeMsg, thread: FakeRecognizer): FromRecognize {
  return {
    type: 'result',
    taskId: msg.taskId,
    result: { stub: true, width: msg.width, height: msg.height, meanGrey: 230, inkFrac: 0.1 },
    tripwire: thread.tripwire
  }
}

export class FakePort extends EventEmitter implements PortLike {
  readonly sent: unknown[] = []
  started = false
  closed = false

  postMessage(msg: unknown): void {
    if (this.closed) throw new Error('posted on a closed port')
    this.sent.push(msg)
  }

  start(): void {
    this.started = true
  }

  close(): void {
    this.closed = true
  }

  /** The renderer posts a message. */
  send(data: unknown): void {
    this.emit('message', { data })
  }

  of<K extends string>(key: K): Array<Record<K, unknown>[K]> {
    return this.sent
      .filter((m) => typeof m === 'object' && m !== null && key in m)
      .map((m) => (m as Record<K, unknown>)[key])
  }
}

export class FakeParent extends EventEmitter implements ParentLike {
  readonly sent: unknown[] = []

  postMessage(msg: unknown): void {
    this.sent.push(msg)
  }

  /** Main posts a message (with optional ports). */
  send(data: unknown, ports: PortLike[] = []): void {
    this.emit('message', { data, ports })
  }

  of<K extends string>(key: K): Array<Record<K, unknown>[K]> {
    return this.sent
      .filter((m) => typeof m === 'object' && m !== null && key in m)
      .map((m) => (m as Record<K, unknown>)[key])
  }
}

export interface Harness {
  deps: CoordinatorDeps
  parent: FakeParent
  rasters: FakeRaster[]
  recognizers: FakeRecognizer[]
  exitCodes: number[]
}

export interface HarnessOptions {
  raster?: RasterScript
  recognize?: RecognizeScript
  pageCount?: (src: string) => number
  /** Recognize concurrency: the system info is shaped so the formula yields exactly this. */
  threads?: number
  budgets?: Partial<Budgets>
  tripwire?: () => number
}

export const STUB_MODULE = new WebAssembly.Module(
  new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])
)

export function harness(opts: HarnessOptions = {}): Harness {
  const parent = new FakeParent()
  const rasters: FakeRaster[] = []
  const recognizers: FakeRecognizer[] = []
  const exitCodes: number[] = []
  const threads = opts.threads ?? 2
  const deps: CoordinatorDeps = {
    parent,
    spawnRaster: () => {
      const r = new FakeRaster(
        opts.raster ?? ((m, t) => rendered(m, t)),
        opts.pageCount ?? (() => 10)
      )
      rasters.push(r)
      return r
    },
    spawnRecognize: () => {
      const r = new FakeRecognizer(opts.recognize ?? ((m, t) => recognized(m, t)))
      recognizers.push(r)
      return r
    },
    loadPdfium: async () => STUB_MODULE,
    loadEngine: async () => STUB_MODULE,
    // cpus − 2 = threads, plenty of memory: the formula gives `threads` (≤ 4).
    system: () => ({ totalmem: 64 * 2 ** 30, availableMemory: 32 * 2 ** 30, cpus: threads + 2 }),
    tripwire: opts.tripwire ?? (() => 0),
    tripwireIntact: () => true,
    electronNet: () => ['fetch', 'request', 'resolveHost', 'isOnline'],
    rss: () => 100 * 2 ** 20,
    exit: (code) => exitCodes.push(code),
    budgets: { maxThreads: 4, ...opts.budgets }
  }
  return { deps, parent, rasters, recognizers, exitCodes }
}

export const LIMITS = { onBattery: false, thermal: 'nominal', speedLimit: 100, divisor: 1 } as const
export const INIT = {
  init: {
    limits: LIMITS,
    paths: {
      pdfiumWasm: process.platform === 'win32' ? 'C:\\x\\pdfium.wasm' : '/x/pdfium.wasm'
    }
  }
}
