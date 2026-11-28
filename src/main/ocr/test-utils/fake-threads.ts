// Test-only fakes for the coordinator: scripted raster and recognize threads, the utility process's
// parentPort and a renderer MessagePort. Replies are delivered on a microtask, like a real thread's.

import { EventEmitter } from 'node:events'

import type { CoordinatorDeps, ParentLike, PortLike, WorkerLike } from '../process/coordinator'
import type {
  EngineAssets,
  FromRaster,
  FromRecognize,
  ToRaster,
  ToRecognize
} from '../process/thread-messages'
import type { RawOcr } from '../../../shared/ocr/engine/types'
import type { Budgets } from '../process/budget'
import type { RecognizeOutcome } from '../process/recognize-core'

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
  /** What this thread's tripwire self-check reports as not tripping (empty: all good). */
  selfCheckFailed: string[] = []

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
export type TriageMsg = Extract<ToRaster, { type: 'triage' }>
/** What a scripted raster thread does with one triage chunk. */
export type TriageScript = (msg: TriageMsg, thread: FakeRaster) => FromRaster | 'hang' | 'crash'

/** A triage answer: every page of the chunk `scanned` at 300 DPI. */
export function triaged(msg: TriageMsg, thread: FakeRaster): FromRaster {
  return {
    type: 'triaged',
    taskId: msg.taskId,
    pages: msg.pages.map((index) => ({
      index,
      pageClass: 'scanned' as const,
      renderDpi: 300,
      raster: { width: 2550, height: 3300 },
      effectiveDpi: 300,
      bitsPerPixel: 1,
      imageOrigin: false
    })),
    heap: thread.heap,
    tripwire: thread.tripwire
  }
}
/** What a scripted raster thread does with one render: a reply, or 'hang' (never answers). */
export type RasterScript = (msg: RenderMsg, thread: FakeRaster) => FromRaster | 'hang' | 'crash'

export class FakeRaster extends FakeWorker<ToRaster, FromRaster> {
  heap = 20 * 2 ** 20
  readonly renders: RenderMsg[] = []
  readonly triages: TriageMsg[] = []
  readonly closed: string[] = []

  constructor(
    private readonly script: RasterScript,
    private readonly pageCount: (src: string) => number,
    /** What opening (and counting) `src` does instead of answering `opened`, if anything. */
    private readonly onOpen?: (src: string, thread: FakeRaster) => FromRaster | 'crash' | undefined,
    private readonly onTriage: TriageScript = triaged
  ) {
    super()
  }

  protected handle(msg: ToRaster): void {
    if (msg.type === 'init')
      this.reply({ type: 'ready', tripwire: this.tripwire, selfCheckFailed: this.selfCheckFailed })
    else if (msg.type === 'open') {
      const out = msg.count ? this.onOpen?.(msg.src, this) : undefined
      if (out === 'crash') this.crash(new Error('raster thread died opening a source'))
      else if (out) this.reply(out)
      else if (msg.count)
        this.reply({
          type: 'opened',
          src: msg.src,
          pageCount: this.pageCount(msg.src),
          tripwire: this.tripwire
        })
    } else if (msg.type === 'close') this.closed.push(msg.src)
    else if (msg.type === 'triage') {
      this.triages.push(msg)
      const out = this.onTriage(msg, this)
      if (out === 'crash') this.crash(new Error('raster thread died triaging'))
      else if (out !== 'hang') this.reply(out)
    } else if (msg.type === 'render') {
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
  initModule: EngineAssets | null = null
  /** The languages each `add-data` message brought (PR9). */
  readonly addedData: string[][] = []
  private readyHeld = false

  constructor(
    private readonly script: RecognizeScript,
    /** Take a while to start (a real engine needs 0.1–0.25 s): ready only on `releaseReady()`. */
    private readonly holdReady = false
  ) {
    super()
  }

  protected handle(msg: ToRecognize): void {
    if (msg.type === 'init') {
      this.initModule = msg.engine
      if (this.holdReady) this.readyHeld = true
      else this.sayReady()
      return
    }
    if (msg.type === 'add-data') {
      this.addedData.push(Object.keys(msg.data))
      return
    }
    this.jobs.push(msg)
    const out = this.script(msg, this)
    if (out === 'crash') this.crash(new Error('recognize thread died'))
    else if (out !== 'hang') this.reply(out)
  }

  /** A held thread finishes starting. */
  releaseReady(): void {
    if (!this.readyHeld) return
    this.readyHeld = false
    this.sayReady()
  }

  private sayReady(): void {
    this.reply({ type: 'ready', tripwire: this.tripwire, selfCheckFailed: this.selfCheckFailed })
  }
}

/** A recognition of one word, "scanned", in the middle of a width × height raster. */
export function oneWord(width: number, height: number): RawOcr {
  const x0 = Math.floor(width / 4)
  const y0 = Math.floor(height / 2)
  const h = Math.max(4, Math.floor(height / 40))
  const bbox = { x0, y0, x1: x0 + 4 * h, y1: y0 + h }
  return {
    lines: [
      {
        kind: 'ocr_line',
        bbox,
        baseline: { slope: 0, intercept: 0 },
        xHeight: h / 2,
        size: h,
        words: [{ text: 'scanned', bbox, conf: 92 }]
      }
    ],
    meanConf: 92,
    confSource: 'word'
  }
}

/** A recognize-thread outcome around `raw`: pass 1 only, upright, no deskew, no adaptive pass. */
export function outcomeOf(raw: RawOcr, extra: Partial<RecognizeOutcome> = {}): RecognizeOutcome {
  return {
    raw,
    chosen: 'pass1',
    passes: [],
    toSource: [1, 0, 0, 1, 0, 0],
    orientation: 0,
    plan: { quarterTurns: 0, skewDeg: 0 },
    recipe: { psm: 3, thresholding: 0 },
    adaptive: null,
    stats: {
      photo: false,
      noisy: false,
      specks: 0,
      borderRemoved: 0,
      ink: 0,
      vertical: false,
      skew: { deg: 0, conf: 0, applied: false },
      orientationChecked: false,
      flipped: false,
      chars: 0,
      meanConfCal: null
    },
    ...extra
  }
}

export function recognized(msg: RecognizeMsg, thread: FakeRecognizer): FromRecognize {
  return {
    type: 'result',
    taskId: msg.taskId,
    result: outcomeOf(oneWord(msg.width, msg.height)),
    heap: 50 * 2 ** 20,
    stderrLines: 0,
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
  /** Recognize threads only say ready when the test calls `releaseReady()`. */
  holdRecognizeReady?: boolean
  /** See FakeRaster: what a counted open of a source does instead of `opened`. */
  rasterOpen?: (src: string, thread: FakeRaster) => FromRaster | 'crash' | undefined
  /** What a raster thread does with a triage chunk (default: every page `scanned`). */
  rasterTriage?: TriageScript
}

/** A passing self-check, as index.ts reports it. */
export const SELF_CHECK = { checked: ['fetch', 'process._linkedBinding'], failed: [] as string[] }

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
        opts.pageCount ?? (() => 10),
        opts.rasterOpen,
        opts.rasterTriage
      )
      rasters.push(r)
      return r
    },
    spawnRecognize: () => {
      const r = new FakeRecognizer(
        opts.recognize ?? ((m, t) => recognized(m, t)),
        opts.holdRecognizeReady
      )
      recognizers.push(r)
      return r
    },
    loadPdfium: async () => STUB_MODULE,
    loadEngine: async (paths) => ({
      assets: { module: STUB_MODULE, coreDir: paths.ocrCore, data: {} },
      dataHashes: { eng: 'e'.repeat(64) }
    }),
    // cpus − 2 = threads, plenty of memory: the formula gives `threads` (≤ 4).
    system: () => ({ totalmem: 64 * 2 ** 30, availableMemory: 32 * 2 ** 30, cpus: threads + 2 }),
    tripwire: opts.tripwire ?? (() => 0),
    tripwireIntact: () => true,
    electronNet: () => ['fetch', 'request', 'resolveHost', 'isOnline'],
    selfCheck: () => SELF_CHECK,
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
      pdfiumWasm: process.platform === 'win32' ? 'C:\\x\\pdfium.wasm' : '/x/pdfium.wasm',
      ocrCore: process.platform === 'win32' ? 'C:\\x\\ocr' : '/x/ocr',
      tessdata: {
        eng:
          process.platform === 'win32'
            ? 'C:\\x\\ocr\\eng.traineddata.gz'
            : '/x/ocr/eng.traineddata.gz',
        deu:
          process.platform === 'win32'
            ? 'C:\\x\\ocr\\deu.traineddata.gz'
            : '/x/ocr/deu.traineddata.gz'
      }
    }
  }
}
