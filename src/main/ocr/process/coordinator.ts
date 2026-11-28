// The utility process's coordinator (DESIGN.md §3.3): the scheduler, watchdogs, recycling and the
// failure policy around one raster thread and N recognize threads. It owns no Electron or
// worker_threads import: index.ts hands it the parentPort and thread factories, so the whole state
// machine runs in vitest with fake threads (coordinator.node.test.ts) and with the real bundled
// threads (process.node.test.ts).
//
// Rules implemented here, by section:
// §3.3.1  The renderer port carries the protocol keyed by SOURCE TOKEN; every message is validated
//         and anything unknown is answered with `bad-message`. Results go back with no transfer
//         list (MessagePortMain cannot transfer). Received bytes are copied once into a
//         SharedArrayBuffer that the raster thread reads in place and that outlives a raster
//         respawn.
// §3.3.3  n recognize threads from the memory/CPU formula; render ahead at most n + 1 pages; pages
//         over 12 MP run solo and recycle their thread; recycle every thread after 50 pages; Σ
//         source bytes ≤ 1 GB (LRU, one bigger source still opens alone); recycle the raster thread
//         between documents once its heap passes 1.2 GB.
// §3.3.4  Cancel drops queued pages and terminates busy recognize threads. Recognize watchdog →
//         terminate, page `timeout`. A recognize trap/OOM → respawn, re-queue once, then `failed`;
//         an OOM-shaped error, or ERR_WORKER_OUT_OF_MEMORY from the thread's V8 heap cap (budget.ts
//         THREAD_RESOURCE_LIMITS), halves n for the session. Raster: any fatal (RuntimeError, thread
//         error, watchdog) → respawn and re-queue once, then `failed`; "Cannot enlarge memory"
//         during a render or no headroom → recycle and retry once, then `too-large`. A page queued
//         behind a failure carries on.
// §3.3.5  Progress ≤ 10 Hz per job; activity (busy, done, total) to main for the power blocker.
// §3.3.6  Work order: the focused page, then the rest of its source, then the other jobs in order.
// §3.4.1  Triage requests go to the raster thread in chunks of TRIAGE_CHUNK pages, one PDFium task
//         at a time with the renders, which go first (triage is background work). A chunk that
//         kills the thread is retried one page at a time, uncharged; a page that kills it twice is
//         reported with `failure: 'raster-crash'`, and once TRIAGE_SOURCE_CRASH_PAGES pages of one
//         source have, the rest of that source's triage is answered the same way without PDFium.
//         Every page a thread returns is validated before it is forwarded.

import {
  ELECTRON_NET_MEMBERS,
  OCR_LIMITS,
  OcrError,
  parseMainToOcr,
  parseToOcr,
  parseTriagePage,
  type FromOcr,
  type Heartbeat,
  type OcrHostLimits,
  type OcrPaths,
  type OcrToMain,
  type PageRequest,
  type PageResult,
  type RecognizeRequest,
  type TripwireSelfCheck
} from '../../../shared/ocr/protocol'
import {
  concurrency,
  defaultBudgets,
  rasterWatchdogMs,
  recognizeWatchdogMs,
  type Budgets,
  type SystemInfo
} from './budget'
import { TESS_CORE7_PLACEHOLDER } from '../../../shared/ocr/calibration'
import { ENGINE_ID, PIPELINE_VERSION } from '../../../shared/ocr/engine/tess-core'
import { mapRawOcr } from '../../../shared/ocr/map'
import type { PackedOcrPage } from '../../../shared/ocr/types'
import { fitRaster } from './raster-core'
import type { RecognizeOutcome } from './recognize-core'
import type {
  EngineAssets,
  FromRaster,
  FromRecognize,
  ToRaster,
  ToRecognize
} from './thread-messages'
import type { TriagePage } from '../../../shared/ocr/triage'

// ---------------------------------------------------------------------------------------------
// Injected surfaces (structural, so Node's Worker and Electron's MessagePortMain both fit).

export interface WorkerLike {
  postMessage(msg: unknown, transfer?: readonly ArrayBuffer[]): void
  on(event: 'message', listener: (msg: unknown) => void): unknown
  on(event: 'error', listener: (err: Error) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
  terminate(): unknown
}

export interface PortLike {
  on(event: 'message', listener: (e: { data: unknown }) => void): unknown
  on(event: 'close', listener: () => void): unknown
  postMessage(msg: unknown): void
  start(): void
  close(): void
}

export interface ParentLike {
  on(
    event: 'message',
    listener: (e: { data: unknown; ports: readonly PortLike[] }) => void
  ): unknown
  postMessage(msg: unknown): void
}

export interface CoordinatorDeps {
  parent: ParentLike
  spawnRaster(): WorkerLike
  spawnRecognize(): WorkerLike
  /** Compile pdfium.wasm (main resolves the path; the renderer never names one). */
  loadPdfium(path: string): Promise<WebAssembly.Module>
  /**
   * The recognize engine: the SHA-checked simd-lstm core compiled once, and each bundled
   * language's verified .traineddata.gz (engine-node.ts). Main resolves the paths.
   */
  loadEngine(paths: OcrPaths): Promise<LoadedEngine>
  system(): SystemInfo
  /** This realm's tripwire count. */
  tripwire(): number
  /** Does every API this realm's tripwire replaced still hold the stub? */
  tripwireIntact(): boolean
  /** The electron.net members this realm's tripwire stubbed. */
  electronNet(): string[]
  /** This realm's tripwire self-check (no-network.ts `tripwireSelfCheck`), run once at start. */
  selfCheck(): TripwireSelfCheck
  rss(): number
  exit(code: number): void
  /** `process.platform` (PER_WORKER depends on it); tests pass another. */
  platform?: string
  budgets?: Partial<Budgets>
}

export interface LoadedEngine {
  /** Posted to every recognize thread's init. */
  assets: EngineAssets
  /** SHA-256 of each language's shipped .traineddata.gz (into every OcrPage, §3.5.1). */
  dataHashes: Record<string, string>
}

// ---------------------------------------------------------------------------------------------
// State.

type TaskState = 'queued' | 'rendering' | 'rendered' | 'recognizing'

interface Job {
  jobId: string
  src: string
  seq: number
  total: number
  done: number
  failed: number
  langs: string[]
  dpi: number
  tasks: Set<Task>
  progressDirty: boolean
}

interface Task {
  id: number
  job: Job
  req: PageRequest
  order: number
  state: TaskState
  /** Raster crash/watchdog failures (re-queued once). */
  rasterFailures: number
  /** Heap-exhausted outcomes (retried once in a fresh raster thread). */
  heapFailures: number
  recognizeFailures: number
  bitmap: ArrayBuffer | null
  raster: { width: number; height: number; dpi: number } | null
  startedAt: number
}

interface Source {
  src: string
  sab: SharedArrayBuffer
  bytes: number
  lastUse: number
  /** The renderer is still waiting for `opened`. */
  countPending: boolean
  /** From the raster thread's `opened` (a triage of every page needs it). */
  pageCount: number | null
  /** Pages of this source whose triage killed the raster thread twice on their own. */
  triageCrashedPages: number
}

/** A renderer `triage` request (§3.4.1). */
interface TriageTask {
  id: number
  src: string
  /** Pages still to triage, in request order; null until the page count is known (all pages). */
  pending: number[] | null
  /** The chunk at the raster thread (a prefix of `pending`), or null. */
  chunk: number[] | null
  /** Pages that go one per message: they were in a chunk that killed the thread. */
  solo: Set<number>
  /** Thread deaths charged to a page sent alone. */
  failures: Map<number, number>
}

interface Slot<M> {
  worker: WorkerLike
  ready: boolean
  dead: boolean
  outbox: Array<{ msg: M; transfer?: ArrayBuffer[] }>
  tripwire: number
}

interface RasterSlot extends Slot<ToRaster> {
  task: Task | null
  watchdog: ReturnType<typeof setTimeout> | null
  heap: number
  lastSrc: string | null
  /**
   * The PDFium work sent to the thread and not answered yet, in send order: renders, and opens with
   * `count: true` (the only opens that call into PDFium). The thread handles messages one at a time
   * in order, so when it traps, dies or hangs, the head of this list is what it was doing.
   */
  inflight: Array<{ open: string } | { render: number } | { triage: number }>
  /** The triage task whose chunk the thread is working on (never together with `task`). */
  triage: TriageTask | null
}

interface RecognizeSlot extends Slot<ToRecognize> {
  task: Task | null
  watchdog: ReturnType<typeof setTimeout> | null
  pages: number
  /** The task running is over the big-page threshold. */
  big: boolean
}

const DEFAULT_RENDER_DPI = 300
/** Pages per triage message (PDFium triage takes milliseconds per page). */
export const TRIAGE_CHUNK = 32
/** A triage chunk that takes longer than this is treated like a hung render. */
export const triageWatchdogMs = (pages: number): number => 15_000 + 1_000 * pages
/** Pages of one source whose triage may kill the raster thread before the rest is not tried. */
export const TRIAGE_SOURCE_CRASH_PAGES = 2

/** A triage result with nothing known (the base of every failure entry). */
const noPage = (index: number): TriagePage => ({
  index,
  pageClass: null,
  renderDpi: null,
  raster: null,
  effectiveDpi: null,
  bitsPerPixel: null,
  imageOrigin: false
})
/** Consecutive threads of one kind that may die before ever reporting ready. */
const MAX_START_FAILURES = 3
/**
 * Fatals of raster threads that had started, within RASTER_FATAL_WINDOW_MS, before the process
 * gives up. Each page is retried once and a source that kills its open is dropped, so only a stream
 * of distinct failures (many trapping pages, a module that traps on everything) gets here.
 */
const MAX_RASTER_FATALS = 10
const RASTER_FATAL_WINDOW_MS = 60_000
const DEFAULT_LIMITS: OcrHostLimits = {
  onBattery: false,
  thermal: 'unknown',
  speedLimit: 100,
  divisor: 1
}

/**
 * An error that looks like memory exhaustion (halves n for the session; §3.3.4). Not a stack
 * overflow: V8 and WASM report one as RangeError "Maximum call stack size exceeded", but the stack is
 * a fixed 4 MiB per thread (budget.ts), so fewer threads cannot help.
 */
export function isOomShaped(name: string, message: string): boolean {
  return (
    // The recognize thread's name for a WASM OOM (Recognize rc ≠ 0, or empty hOCR with a
    // Leptonica allocation failure on printErr; PR0b §f).
    name === 'OcrOutOfMemory' ||
    (name === 'RangeError' && !/Maximum call stack size exceeded/i.test(message)) ||
    /out of memory|Cannot enlarge memory|memory access out of bounds|Array buffer allocation failed/i.test(
      message
    )
  )
}

/**
 * A thread's 'error' event that is memory exhaustion: the V8 heap cap (`threadOptions`) gives
 * ERR_WORKER_OUT_OF_MEMORY ("Worker terminated due to reaching memory limit: JS heap out of
 * memory"); a WASM-side failure arrives OOM-shaped.
 */
export function isThreadOom(err: unknown): boolean {
  const e = (err ?? {}) as { name?: unknown; message?: unknown; code?: unknown }
  if (e.code === 'ERR_WORKER_OUT_OF_MEMORY') return true
  return isOomShaped(
    typeof e.name === 'string' ? e.name : 'Error',
    typeof e.message === 'string' ? e.message : ''
  )
}

export class Coordinator {
  private readonly b: Budgets
  private limits: OcrHostLimits = DEFAULT_LIMITS
  private pdfiumModule: Promise<WebAssembly.Module> | null = null
  private engineModule: Promise<LoadedEngine> | null = null
  /** The engine once loaded (the hashes go into every page). */
  private engine: LoadedEngine | null = null
  /** Languages main gave paths for (known at init, before the engine has loaded). */
  private availableLangs = new Set<string>()
  private port: PortLike | null = null

  private readonly sources = new Map<string, Source>()
  private readonly jobs = new Map<string, Job>()
  private readonly tasks = new Set<Task>()
  private readonly triages: TriageTask[] = []
  private focus: { src: string; index: number } | null = null
  private jobSeq = 0
  private taskSeq = 0

  private raster: RasterSlot | null = null
  private readonly recognizers: RecognizeSlot[] = []
  /** Session halving from OOM-shaped recognize failures. */
  private localDivisor = 1
  /**
   * Threads that died, errored or hung before reporting ready, in a row; past the cap the process
   * gives up. A thread the coordinator retired on purpose (cancel, close, a new port, shedding) is
   * never counted, ready or not.
   */
  private startFailures = { raster: 0, recognize: 0 }
  /** When started raster threads hit a fatal (RASTER_FATAL_WINDOW_MS). */
  private rasterFatals: number[] = []
  private gaveUp = false
  /** Self-check failures reported by any thread so far (never document data: API names). */
  private readonly threadSelfCheckFailed = new Set<string>()

  private retiredTripwire = { raster: 0, recognize: 0 }
  private expectedPageMs = 4000
  private lastFlush = -Infinity
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  /** The last activity sent to main; starts idle so an idle process says nothing. */
  private lastActivity = 'false:0:0'
  private readonly heartbeatTimer: ReturnType<typeof setInterval>
  private disposed = false

  constructor(private readonly deps: CoordinatorDeps) {
    const base = defaultBudgets(deps.platform ?? process.platform)
    this.b = {
      ...base,
      ...deps.budgets,
      raster: { ...base.raster, ...deps.budgets?.raster }
    }
    deps.parent.on('message', (e) => this.guard(() => this.onParent(e.data, e.ports), false))
    this.heartbeatTimer = setInterval(() => this.postHeartbeat(), this.b.heartbeatIntervalMs)
    ;(this.heartbeatTimer as { unref?: () => void }).unref?.()
    this.toParent({
      ready: {
        tripwire: deps.tripwire(),
        electronNet: deps.electronNet() as Array<(typeof ELECTRON_NET_MEMBERS)[number]>,
        selfCheck: deps.selfCheck()
      }
    })
  }

  /** Counts for tests and the heartbeat. */
  snapshot(): {
    sources: string[]
    jobs: string[]
    queued: number
    rendered: number
    recognizing: number
    rasterLive: boolean
    recognizeThreads: number
    concurrency: number
  } {
    let queued = 0
    let rendered = 0
    let recognizing = 0
    for (const t of this.tasks) {
      if (t.state === 'queued') queued++
      else if (t.state === 'rendered') rendered++
      else if (t.state === 'recognizing') recognizing++
    }
    return {
      sources: [...this.sources.keys()],
      jobs: [...this.jobs.keys()],
      queued,
      rendered,
      recognizing,
      rasterLive: !!this.raster,
      recognizeThreads: this.recognizers.length,
      concurrency: this.concurrency()
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    clearInterval(this.heartbeatTimer)
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.resetSession()
    if (this.raster) this.retireRaster()
    for (const s of [...this.recognizers]) this.retireRecognizer(s)
    this.port?.close()
    this.port = null
  }

  // -------------------------------------------------------------------------------------------
  // Links.

  /**
   * Run a handler; a throw is a bug or a malformed message, never a reason to stop serving. Tell
   * the renderer without content (`reply`); main's messages come from trusted code, so a bad one
   * from there is only dropped.
   */
  private guard(fn: () => void, reply = true): void {
    try {
      fn()
    } catch (e) {
      if (!reply) return
      const code = e instanceof OcrError ? e.code : 'internal'
      const message = e instanceof OcrError ? e.message : 'internal error'
      this.toRenderer({ error: { code, message } })
    }
  }

  private toParent(msg: OcrToMain): void {
    this.deps.parent.postMessage(msg)
  }

  private toRenderer(msg: FromOcr): void {
    // No transfer list, ever (PR0: MessagePortMain.postMessage(msg, [buf]) throws).
    this.port?.postMessage(msg)
  }

  private onParent(data: unknown, ports: readonly PortLike[]): void {
    const msg = parseMainToOcr(data)
    if ('init' in msg) {
      this.limits = msg.init.limits
      this.pdfiumModule = this.deps.loadPdfium(msg.init.paths.pdfiumWasm)
      this.availableLangs = new Set(Object.keys(msg.init.paths.tessdata))
      this.engineModule = this.deps.loadEngine(msg.init.paths)
      this.engineModule.then(
        (e) => {
          this.engine = e
        },
        () => {}
      )
      const fatal = (e: unknown): void =>
        this.toParent({
          fatal: { code: 'init', message: e instanceof Error ? e.name : 'init failed' }
        })
      this.pdfiumModule.catch(fatal)
      this.engineModule.catch(fatal)
    } else if ('port' in msg) {
      const port = ports[0]
      if (!port) throw new OcrError('bad-message', 'port message without a port')
      this.setPort(port)
    } else if ('limits' in msg) {
      this.limits = msg.limits
      this.pump()
    } else if ('heartbeat' in msg) {
      this.postHeartbeat()
    } else if ('shutdown' in msg) {
      this.dispose()
      this.deps.exit(0)
    }
  }

  /** A new renderer port replaces the old one: the old renderer's work is void. Never reused. */
  private setPort(port: PortLike): void {
    if (this.port) {
      this.resetSession()
      this.port.close()
    }
    this.port = port
    port.on('message', (e) => {
      if (this.port === port) this.guard(() => this.onRenderer(e.data))
    })
    port.on('close', () => {
      if (this.port !== port) return
      this.port = null
      this.resetSession()
    })
    port.start()
  }

  private onRenderer(data: unknown): void {
    let msg
    try {
      msg = parseToOcr(data)
    } catch (e) {
      this.toRenderer({
        error: { code: 'bad-message', message: e instanceof Error ? e.message : 'bad message' }
      })
      return
    }
    if ('open' in msg) this.open(msg.open.src, msg.open.bytes)
    else if ('triage' in msg) this.triage(msg.triage.src, msg.triage.pages)
    else if ('recognize' in msg) this.recognize(msg.recognize)
    else if ('cancel' in msg) this.cancelJob(msg.cancel, true)
    else if ('close' in msg) this.closeSource(msg.close)
    else if ('focus' in msg) {
      this.focus = msg.focus
      this.pump()
    }
  }

  // -------------------------------------------------------------------------------------------
  // Sources (reconcile-by-source-token lives in the renderer; here `close` is final for its token).

  private open(src: string, bytes: Uint8Array): void {
    if (this.sources.has(src)) {
      this.toRenderer({ error: { code: 'duplicate', message: 'source already open', src } })
      return
    }
    if (bytes.byteLength > OCR_LIMITS.maxSourceBytes) {
      this.toRenderer({ error: { code: 'too-large', message: 'source over 1.5 GB', src } })
      return
    }
    let sab: SharedArrayBuffer
    try {
      sab = new SharedArrayBuffer(bytes.byteLength)
    } catch {
      // Allocation failure is memory, not a malformed request.
      this.toRenderer({ error: { code: 'too-large', message: 'no memory for the source', src } })
      return
    }
    new Uint8Array(sab).set(bytes)
    const source: Source = {
      src,
      sab,
      bytes: bytes.byteLength,
      lastUse: Date.now(),
      countPending: true,
      pageCount: null,
      triageCrashedPages: 0
    }
    this.sources.set(src, source)
    this.evictOverBudget(src)
    // A raster thread spawned now registers every source itself (ensureRaster).
    const existed = this.raster !== null
    const r = this.ensureRaster()
    if (existed) this.sendRaster(r, { type: 'open', src, data: sab, count: true })
  }

  /** Drop least-recently used sources with no pending work until Σ bytes fits (§3.3.3). */
  private evictOverBudget(keep: string): void {
    let total = 0
    for (const s of this.sources.values()) total += s.bytes
    if (total <= this.b.sourceBudget) return
    const busy = new Set<string>()
    for (const j of this.jobs.values()) busy.add(j.src)
    for (const t of this.triages) busy.add(t.src)
    const victims = [...this.sources.values()]
      .filter((s) => s.src !== keep && !busy.has(s.src))
      .sort((a, b) => a.lastUse - b.lastUse)
    for (const v of victims) {
      if (total <= this.b.sourceBudget) break
      total -= v.bytes
      this.dropSource(v.src)
      this.toRenderer({ evicted: { src: v.src } })
    }
  }

  private dropSource(src: string): void {
    this.sources.delete(src)
    // Its triage requests end with it (a chunk in flight is dropped when it answers).
    for (let i = this.triages.length - 1; i >= 0; i--)
      if (this.triages[i].src === src) this.triages.splice(i, 1)
    if (this.raster) this.sendRaster(this.raster, { type: 'close', src })
    if (this.focus?.src === src) this.focus = null
  }

  private closeSource(src: string): void {
    // Unknown tokens are a no-op: the renderer may close a source the LRU already evicted.
    for (const job of [...this.jobs.values()]) if (job.src === src) this.cancelJob(job.jobId, true)
    if (this.sources.has(src)) this.dropSource(src)
  }

  private resetSession(): void {
    for (const id of [...this.jobs.keys()]) this.cancelJob(id, false)
    for (const src of [...this.sources.keys()]) this.dropSource(src)
    this.focus = null
  }

  // -------------------------------------------------------------------------------------------
  // Triage (§3.4.1).

  private triage(src: string, pages: number[] | undefined): void {
    const source = this.sources.get(src)
    if (!source) {
      this.toRenderer({ error: { code: 'not-open', message: 'source not open', src } })
      return
    }
    source.lastUse = Date.now()
    if (pages && pages.length === 0) {
      this.toRenderer({ triaged: { src, pages: [], done: true } })
      return
    }
    const task: TriageTask = {
      id: ++this.taskSeq,
      src,
      pending: pages
        ? [...pages]
        : source.pageCount === null
          ? null
          : Array.from({ length: source.pageCount }, (_, i) => i),
      chunk: null,
      solo: new Set(),
      failures: new Map()
    }
    this.triages.push(task)
    // A source that already broke the circuit (or a process that gave up) answers without PDFium.
    if (this.gaveUp) task.pending ??= []
    if ((this.gaveUp || source.triageCrashedPages >= TRIAGE_SOURCE_CRASH_PAGES) && task.pending) {
      this.failTriage(task)
      return
    }
    if (source.pageCount === 0 && !pages) this.finishEmptyTriages(src)
    this.pump()
  }

  /** Answer every page `task` still has with `failure: 'raster-crash'` and end it. */
  private failTriage(task: TriageTask): void {
    const i = this.triages.indexOf(task)
    if (i < 0) return
    this.triages.splice(i, 1)
    const rest = task.pending ?? []
    task.pending = []
    task.chunk = null
    if (rest.length === 0) {
      this.toRenderer({ triaged: { src: task.src, pages: [], done: true } })
      return
    }
    for (let k = 0; k < rest.length; k += TRIAGE_CHUNK) {
      const part = rest.slice(k, k + TRIAGE_CHUNK)
      this.toRenderer({
        triaged: {
          src: task.src,
          pages: part.map((p) => ({ ...noPage(p), failure: 'raster-crash' as const })),
          done: k + TRIAGE_CHUNK >= rest.length
        }
      })
    }
  }

  /** A whole-document triage of a source with no pages answers at once. */
  private finishEmptyTriages(src: string): void {
    for (let i = this.triages.length - 1; i >= 0; i--) {
      const t = this.triages[i]
      if (t.src !== src || !t.pending || t.pending.length > 0 || t.chunk) continue
      this.triages.splice(i, 1)
      this.toRenderer({ triaged: { src, pages: [], done: true } })
    }
  }

  private startTriage(r: RasterSlot, task: TriageTask): void {
    const pending = task.pending!
    const chunk: number[] = []
    if (task.solo.has(pending[0])) chunk.push(pending[0])
    else
      for (const p of pending) {
        if (chunk.length >= TRIAGE_CHUNK || task.solo.has(p)) break
        chunk.push(p)
      }
    const source = this.sources.get(task.src)
    if (source) source.lastUse = Date.now()
    task.chunk = chunk
    r.triage = task
    r.lastSrc = task.src
    r.watchdog = setTimeout(
      () => this.guard(() => this.onRasterHang(r)),
      triageWatchdogMs(chunk.length)
    )
    this.sendRaster(r, { type: 'triage', taskId: task.id, src: task.src, pages: chunk })
  }

  /** The thread answered (or died on) `slot.triage`'s chunk: take it off the slot. */
  private takeTriage(slot: RasterSlot, taskId: number): TriageTask | null {
    const task = slot.triage
    if (!task || task.id !== taskId) return null
    if (slot.watchdog) clearTimeout(slot.watchdog)
    slot.watchdog = null
    slot.triage = null
    // Closed while triaging: its answer is dropped.
    return this.triages.includes(task) ? task : null
  }

  /** Forward a chunk's (or a page's) results; the request ends with its last page. */
  private triageAnswered(task: TriageTask, answered: number[], pages: TriagePage[]): void {
    const pending = task.pending!
    const done = new Set(answered)
    task.pending = pending.filter((p) => !done.has(p))
    const finished = task.pending.length === 0
    if (finished) this.triages.splice(this.triages.indexOf(task), 1)
    this.toRenderer({ triaged: { src: task.src, pages, done: finished } })
  }

  /**
   * The raster thread died, trapped or hung on a triage chunk. A chunk of several pages cannot say
   * which page did it, so its pages go again one at a time, uncharged; a page that kills the thread
   * twice on its own is reported as failed and skipped (§3.3.4's page rule).
   */
  private triageCrashed(slot: RasterSlot, taskId: number): void {
    const task = this.takeTriage(slot, taskId)
    const chunk = task?.chunk
    if (!task || !chunk) return
    task.chunk = null
    if (chunk.length > 1) {
      for (const p of chunk) task.solo.add(p)
      return
    }
    const p = chunk[0]
    const n = (task.failures.get(p) ?? 0) + 1
    task.failures.set(p, n)
    if (n < 2) return
    this.triageAnswered(task, [p], [{ ...noPage(p), failure: 'raster-crash' }])
    // Circuit breaker: pages of one source that keep killing PDFium usually share the cause (a
    // self-referencing Form, a trapping image used on every page). Past the limit the rest of the
    // source's triage fails without PDFium, so one document cannot exhaust the process-wide fatal
    // budget and take OCR down for every source.
    const source = this.sources.get(task.src)
    if (!source) return
    source.triageCrashedPages++
    if (source.triageCrashedPages < TRIAGE_SOURCE_CRASH_PAGES) return
    for (const t of [...this.triages]) if (t.src === task.src && t.pending) this.failTriage(t)
  }

  /**
   * The pages a thread returned for `chunk`, validated: one the port would reject (a NaN, a 0 DPI)
   * becomes a `render` failure instead of making the renderer drop the whole message, a page the
   * thread left out is answered the same way, and anything not asked for is dropped.
   */
  private checkedTriage(chunk: number[], pages: unknown): TriagePage[] {
    const asked = new Set(chunk)
    const got = new Map<number, TriagePage>()
    for (const [i, raw] of (Array.isArray(pages) ? pages : []).entries()) {
      const index = (raw as { index?: unknown } | null)?.index
      if (typeof index !== 'number' || !asked.has(index) || got.has(index)) continue
      try {
        got.set(index, parseTriagePage(raw, `triaged.pages[${i}]`))
      } catch {
        got.set(index, { ...noPage(index), failure: 'render' })
      }
    }
    return chunk.map((p) => got.get(p) ?? { ...noPage(p), failure: 'render' })
  }

  // -------------------------------------------------------------------------------------------
  // Jobs.

  private recognize(req: RecognizeRequest): void {
    const source = this.sources.get(req.src)
    if (!source) {
      this.toRenderer({
        error: { code: 'not-open', message: 'source not open', src: req.src, jobId: req.jobId }
      })
      return
    }
    if (this.jobs.has(req.jobId)) {
      this.toRenderer({ error: { code: 'duplicate', message: 'job id in use', jobId: req.jobId } })
      return
    }
    source.lastUse = Date.now()
    const job: Job = {
      jobId: req.jobId,
      src: req.src,
      seq: this.jobSeq++,
      total: req.pages.length,
      done: 0,
      failed: 0,
      langs: req.opts.langs,
      dpi: req.opts.renderDpi ?? DEFAULT_RENDER_DPI,
      tasks: new Set(),
      progressDirty: true
    }
    this.jobs.set(job.jobId, job)
    // A language that is neither bundled nor installed: nothing to recognise with (§3.5.1).
    const missing = req.opts.langs.some((l) => !this.availableLangs.has(l))
    req.pages.forEach((p, order) => {
      const t: Task = {
        id: ++this.taskSeq,
        job,
        req: p,
        order,
        state: 'queued',
        rasterFailures: 0,
        heapFailures: 0,
        recognizeFailures: 0,
        bitmap: null,
        raster: null,
        startedAt: 0
      }
      job.tasks.add(t)
      this.tasks.add(t)
    })
    if (missing)
      for (const t of [...job.tasks])
        this.finalize(t, {
          status: 'needs-language',
          renderDpi: null,
          raster: null,
          recognition: null
        })
    this.scheduleFlush()
    this.pump()
  }

  private cancelJob(jobId: string, notify: boolean): void {
    const job = this.jobs.get(jobId)
    if (!job) return
    for (const t of job.tasks) {
      this.tasks.delete(t)
      // No abort inside the WASM: a busy recognize thread is terminated (PR0: terminate() interrupts
      // a synchronous Recognize in ms). A render in flight finishes in milliseconds and its result
      // is dropped because its task is gone.
      if (t.state === 'recognizing') {
        const slot = this.recognizers.find((s) => s.task === t)
        if (slot && !slot.ready) this.unassign(slot)
        else if (slot) this.retireRecognizer(slot)
      }
      t.bitmap = null
    }
    job.tasks.clear()
    this.jobs.delete(jobId)
    if (notify)
      this.toRenderer({
        jobDone: { jobId, done: job.done, failed: job.failed, cancelled: true }
      })
    this.scheduleFlush()
    this.pump()
  }

  private finalize(t: Task, page: PageResult): void {
    if (!this.tasks.has(t)) return
    this.tasks.delete(t)
    const job = t.job
    job.tasks.delete(t)
    if (page.status === 'failed' || page.status === 'too-large' || page.status === 'timeout')
      job.failed++
    else {
      job.done++
      if (t.startedAt > 0) {
        const ms = Date.now() - t.startedAt
        this.expectedPageMs = 0.7 * this.expectedPageMs + 0.3 * ms
      }
    }
    this.toRenderer({ result: { jobId: job.jobId, src: job.src, index: t.req.index, page } })
    job.progressDirty = true
    if (job.tasks.size === 0) {
      this.jobs.delete(job.jobId)
      this.toRenderer({
        jobDone: { jobId: job.jobId, done: job.done, failed: job.failed, cancelled: false }
      })
    }
    this.scheduleFlush()
  }

  private fail(
    t: Task,
    status: 'failed' | 'too-large' | 'timeout',
    reason: PageResult['reason']
  ): void {
    this.finalize(t, {
      status,
      reason,
      renderDpi: t.raster?.dpi ?? null,
      raster: t.raster ? { width: t.raster.width, height: t.raster.height } : null,
      recognition: null
    })
  }

  private requeue(t: Task): void {
    t.state = 'queued'
    t.bitmap = null
  }

  // -------------------------------------------------------------------------------------------
  // Scheduling.

  private concurrency(): number {
    return concurrency(this.deps.system(), this.limits, this.b, this.localDivisor)
  }

  private rank(t: Task): [number, number, number] {
    const f = this.focus
    const focusRank = f && t.job.src === f.src ? (t.req.index === f.index ? 0 : 1) : 2
    return [focusRank, t.job.seq, t.order]
  }

  private pick(state: TaskState): Task | null {
    let best: Task | null = null
    let bestRank: [number, number, number] | null = null
    for (const t of this.tasks) {
      if (t.state !== state) continue
      const r = this.rank(t)
      if (
        !bestRank ||
        r[0] < bestRank[0] ||
        (r[0] === bestRank[0] &&
          (r[1] < bestRank[1] || (r[1] === bestRank[1] && r[2] < bestRank[2])))
      ) {
        best = t
        bestRank = r
      }
    }
    return best
  }

  private pump(): void {
    if (this.disposed) return
    if (
      this.startFailures.raster >= MAX_START_FAILURES ||
      this.startFailures.recognize >= MAX_START_FAILURES ||
      this.rasterFatals.length >= MAX_RASTER_FATALS
    ) {
      this.giveUp()
      return
    }
    const n = this.concurrency()

    // Raster: one render at a time, at most n + 1 rendered pages waiting.
    let waiting = 0
    let queued = 0
    for (const t of this.tasks) {
      if (t.state === 'rendered') waiting++
      else if (t.state === 'queued') queued++
    }
    // Renders first: triage is background work (§3.4.1, idle priority) and must not hold up the
    // pages a user asked to recognise; it takes the thread whenever no render can start.
    if (queued > 0 && waiting < n + 1 && this.pdfiumModule) {
      const r = this.ensureRaster()
      if (r.ready && !r.task && !r.triage) {
        const t = this.pick('queued')
        if (t) {
          if (r.lastSrc !== null && r.lastSrc !== t.job.src && r.heap > this.b.rasterRecycleHeap) {
            // Between documents and the heap only grows: hand the memory back (§3.3.3).
            this.retireRaster()
            this.ensureRaster()
          } else this.startRender(r, t)
        }
      }
    }
    const triage = this.triages.find((t) => t.pending && t.pending.length > 0 && !t.chunk)
    if (triage && this.pdfiumModule && !this.gaveUp) {
      const r = this.ensureRaster()
      if (r.ready && !r.task && !r.triage) this.startTriage(r, triage)
    }

    // Recognize: up to n threads; a big page runs alone.
    for (;;) {
      const t = this.pick('rendered')
      if (!t || !t.raster) break
      const busy = this.recognizers.filter((s) => s.task)
      if (busy.some((s) => s.big)) break
      const big = t.raster.width * t.raster.height > this.b.bigPagePixels
      if (big && busy.length > 0) break // drain, then run it solo
      let slot = this.recognizers.find((s) => !s.task && !s.dead) ?? null
      if (!slot && this.recognizers.length < n) slot = this.spawnRecognizer()
      if (!slot) break
      this.startRecognize(slot, t, big)
      if (big) break
    }

    // Shed idle threads beyond n (after an OOM halving or a battery/thermal change).
    while (this.recognizers.length > n) {
      const idle = this.recognizers.find((s) => !s.task)
      if (!idle) break
      this.retireRecognizer(idle)
    }
    this.scheduleFlush()
  }

  // -------------------------------------------------------------------------------------------
  // Raster thread.

  private ensureRaster(): RasterSlot {
    if (this.raster) return this.raster
    if (!this.pdfiumModule) throw new OcrError('init', 'no init from main yet')
    const worker = this.deps.spawnRaster()
    const slot: RasterSlot = {
      worker,
      ready: false,
      dead: false,
      outbox: [],
      tripwire: 0,
      task: null,
      watchdog: null,
      heap: 0,
      lastSrc: null,
      inflight: [],
      triage: null
    }
    this.raster = slot
    worker.on('message', (m) => this.guard(() => this.onRaster(slot, m as FromRaster)))
    // A V8 OOM under the heap cap (ERR_WORKER_OUT_OF_MEMORY) is a raster fatal like any other: the
    // page is re-rendered once in a fresh thread, then `failed`. It does not halve n: n counts
    // recognize threads, and this heap is the raster isolate's own.
    worker.on('error', () => this.guard(() => this.onRasterDeath(slot)))
    worker.on('exit', () => this.guard(() => this.onRasterDeath(slot)))
    void this.pdfiumModule.then(
      (pdfium) => {
        if (!slot.dead)
          worker.postMessage({ type: 'init', pdfium, limits: this.b.raster } satisfies ToRaster)
      },
      () => {}
    )
    // A fresh thread knows nothing: re-register every source (lazily opened at the next render).
    for (const s of this.sources.values())
      this.sendRaster(slot, { type: 'open', src: s.src, data: s.sab, count: s.countPending })
    return slot
  }

  private sendRaster(slot: RasterSlot, msg: ToRaster): void {
    if (slot.dead) return
    if (msg.type === 'open' && msg.count) slot.inflight.push({ open: msg.src })
    else if (msg.type === 'render') slot.inflight.push({ render: msg.taskId })
    else if (msg.type === 'triage') slot.inflight.push({ triage: msg.taskId })
    if (!slot.ready) slot.outbox.push({ msg })
    else slot.worker.postMessage(msg)
  }

  private startRender(r: RasterSlot, t: Task): void {
    const job = t.job
    const source = this.sources.get(job.src)
    if (!source) {
      this.fail(t, 'failed', 'render')
      return
    }
    source.lastUse = Date.now()
    t.state = 'rendering'
    if (t.startedAt === 0) t.startedAt = Date.now()
    job.progressDirty = true
    r.task = t
    r.lastSrc = job.src
    const fit = fitRaster(t.req.width, t.req.height, job.dpi, this.b.raster)
    r.watchdog = setTimeout(
      () => this.guard(() => this.onRasterHang(r)),
      rasterWatchdogMs(fit.width * fit.height)
    )
    this.sendRaster(r, {
      type: 'render',
      taskId: t.id,
      src: job.src,
      index: t.req.index,
      dpi: job.dpi,
      userUnit: t.req.userUnit,
      frame: { width: t.req.width, height: t.req.height }
    })
  }

  private takeRasterTask(slot: RasterSlot, taskId: number | null): Task | null {
    if (taskId !== null) this.answered(slot, { render: taskId })
    const t = slot.task
    // Not the render in flight: leave that one (and its watchdog) alone.
    if (!t || (taskId !== null && t.id !== taskId)) return null
    if (slot.watchdog) clearTimeout(slot.watchdog)
    slot.watchdog = null
    slot.task = null
    // Cancelled or closed while rendering: its result is dropped.
    return this.tasks.has(t) ? t : null
  }

  private onRaster(slot: RasterSlot, m: FromRaster): void {
    if (slot !== this.raster || slot.dead) return
    slot.tripwire = m.tripwire
    switch (m.type) {
      case 'ready': {
        slot.ready = true
        this.startFailures.raster = 0
        for (const f of m.selfCheckFailed) this.threadSelfCheckFailed.add(`raster:${f}`)
        const out = slot.outbox.splice(0)
        for (const o of out) slot.worker.postMessage(o.msg)
        break
      }
      case 'opened': {
        this.answered(slot, { open: m.src })
        const s = this.sources.get(m.src)
        if (s) {
          s.pageCount = m.pageCount
          // Whole-document triages were waiting for the count.
          for (const t of [...this.triages])
            if (t.src === m.src && t.pending === null) {
              t.pending = Array.from({ length: m.pageCount }, (_, i) => i)
              if (s.triageCrashedPages >= TRIAGE_SOURCE_CRASH_PAGES) this.failTriage(t)
            }
          this.finishEmptyTriages(m.src)
        }
        if (s && s.countPending) {
          s.countPending = false
          this.toRenderer({ opened: { src: m.src, pageCount: m.pageCount } })
        }
        break
      }
      case 'triaged': {
        slot.heap = m.heap
        this.answered(slot, { triage: m.taskId })
        const task = this.takeTriage(slot, m.taskId)
        const chunk = task?.chunk
        if (task && chunk) {
          task.chunk = null
          this.triageAnswered(task, chunk, this.checkedTriage(chunk, m.pages))
        }
        break
      }
      case 'triage-failed': {
        this.answered(slot, { triage: m.taskId })
        const task = this.takeTriage(slot, m.taskId)
        if (task)
          this.openFailed(
            task.src,
            m.pdfiumError === 4 ? 'password required' : 'PDFium could not open the file'
          )
        break
      }
      case 'open-failed': {
        this.answered(slot, { open: m.src })
        this.openFailed(
          m.src,
          m.pdfiumError === 4 ? 'password required' : 'PDFium could not open the file'
        )
        break
      }
      case 'rendered': {
        slot.heap = m.heap
        const t = this.takeRasterTask(slot, m.taskId)
        if (t) {
          t.state = 'rendered'
          t.bitmap = m.data
          t.raster = { width: m.width, height: m.height, dpi: m.dpi }
        }
        break
      }
      case 'render-failed': {
        slot.heap = m.heap
        const t = this.takeRasterTask(slot, m.taskId)
        if (t) this.fail(t, m.status, m.reason)
        break
      }
      case 'heap-exhausted': {
        // The bitmap (if any) was discarded in the thread: it never reaches a recognize thread.
        const t = this.takeRasterTask(slot, m.taskId)
        if (t) {
          t.heapFailures++
          if (t.heapFailures >= 2) this.fail(t, 'too-large', 'heap')
          else this.requeue(t)
        }
        this.retireRaster()
        break
      }
      case 'fatal': {
        if (!slot.ready) {
          // init itself failed (a bad module, say): a start failure, nothing else to blame.
          this.startFailures.raster++
          this.retireRaster()
          break
        }
        this.rasterCrashed(slot, m.taskId)
        break
      }
    }
    this.pump()
  }

  private answered(
    slot: RasterSlot,
    work: { open: string } | { render: number } | { triage: number }
  ): void {
    const i = slot.inflight.findIndex((w) =>
      'open' in work
        ? 'open' in w && w.open === work.open
        : 'render' in work
          ? 'render' in w && w.render === work.render
          : 'triage' in w && w.triage === work.triage
    )
    if (i >= 0) slot.inflight.splice(i, 1)
  }

  /**
   * A started raster thread trapped (`fatal`), died or hung. Blame what it was doing: the render a
   * fatal names, else the head of `inflight`. A source whose open killed the thread is dropped for
   * good, or every respawned thread would open it again and die again; a render is charged one
   * failure. Anything else in flight was never reached and is re-queued uncharged by retireRaster.
   */
  private rasterCrashed(slot: RasterSlot, taskId: number | null): void {
    const head =
      taskId === null
        ? slot.inflight[0]
        : (slot.inflight.find((w) => 'triage' in w && w.triage === taskId) ?? { render: taskId })
    // A multi-page triage chunk charges no page (its pages go again one at a time), so its death
    // does not count towards giving up either: only deaths a page or an open is charged with do.
    const chunkDeath =
      head !== undefined &&
      'triage' in head &&
      slot.triage?.id === head.triage &&
      (slot.triage.chunk?.length ?? 0) > 1
    if (!chunkDeath) this.noteRasterFatal()
    if (head && 'open' in head) {
      this.retireRaster()
      this.openFailed(head.open, 'PDFium crashed opening the file')
      return
    }
    if (head && 'triage' in head) {
      this.triageCrashed(slot, head.triage)
      this.retireRaster()
      return
    }
    const t = head ? this.takeRasterTask(slot, head.render) : null
    if (t) this.rasterFailure(t)
    this.retireRaster()
  }

  /** A source PDFium cannot open: its jobs end, it is dropped and the renderer told. */
  private openFailed(src: string, message: string): void {
    if (!this.sources.has(src)) return
    for (const job of [...this.jobs.values()]) if (job.src === src) this.cancelJob(job.jobId, true)
    this.dropSource(src)
    this.toRenderer({ error: { code: 'open-failed', message, src } })
  }

  /** Count a fatal of a started raster thread; too many in the window and the process gives up. */
  private noteRasterFatal(): void {
    const now = Date.now()
    this.rasterFatals = this.rasterFatals.filter((t) => now - t < RASTER_FATAL_WINDOW_MS)
    this.rasterFatals.push(now)
  }

  /**
   * A thread kind that cannot even start (bad module, missing file) would otherwise respawn
   * forever. Fail what is pending and tell main, which treats it as fatal (deterministic).
   */
  private giveUp(): void {
    if (this.gaveUp) return
    this.gaveUp = true
    const crashing = this.rasterFatals.length >= MAX_RASTER_FATALS
    const which =
      crashing || this.startFailures.raster >= MAX_START_FAILURES ? 'raster' : 'recognize'
    for (const t of [...this.tasks])
      this.fail(t, 'failed', which === 'raster' ? 'raster-crash' : 'recognize-crash')
    // Every triage request still open ends too: the renderer must not wait for a `done: true` that
    // a process that gave up would never send. A page count still unknown leaves nothing to list.
    for (const t of [...this.triages]) {
      t.pending ??= []
      this.failTriage(t)
    }
    this.toParent({
      fatal: {
        code: 'init',
        message: crashing ? 'raster thread keeps crashing' : `${which} thread failed to start`
      }
    })
  }

  private rasterFailure(t: Task): void {
    t.rasterFailures++
    if (t.rasterFailures >= 2) this.fail(t, 'failed', 'raster-crash')
    else this.requeue(t)
  }

  private onRasterHang(slot: RasterSlot): void {
    if (slot !== this.raster || slot.dead) return
    slot.watchdog = null
    // The watchdog only runs for a render, so the thread had started; an open queued ahead of the
    // render may be what hangs, which rasterCrashed works out.
    this.rasterCrashed(slot, null)
    this.pump()
  }

  private onRasterDeath(slot: RasterSlot): void {
    if (slot !== this.raster || slot.dead) return
    if (!slot.ready) {
      this.startFailures.raster++
      this.retireRaster()
    } else this.rasterCrashed(slot, null)
    this.pump()
  }

  private retireRaster(): void {
    const slot = this.raster
    if (!slot) return
    slot.dead = true
    if (slot.watchdog) clearTimeout(slot.watchdog)
    slot.watchdog = null
    if (slot.task && this.tasks.has(slot.task)) this.requeue(slot.task)
    slot.task = null
    // A triage chunk the thread never answered goes again, uncharged.
    if (slot.triage) slot.triage.chunk = null
    slot.triage = null
    this.retiredTripwire.raster += slot.tripwire
    this.raster = null
    void slot.worker.terminate()
  }

  // -------------------------------------------------------------------------------------------
  // Recognize threads.

  private spawnRecognizer(): RecognizeSlot {
    if (!this.engineModule) throw new OcrError('init', 'no init from main yet')
    const worker = this.deps.spawnRecognize()
    const slot: RecognizeSlot = {
      worker,
      ready: false,
      dead: false,
      outbox: [],
      tripwire: 0,
      task: null,
      watchdog: null,
      pages: 0,
      big: false
    }
    this.recognizers.push(slot)
    worker.on('message', (m) => this.guard(() => this.onRecognize(slot, m as FromRecognize)))
    // A V8 OOM under the heap cap is an 'error' (ERR_WORKER_OUT_OF_MEMORY) and then an 'exit'.
    worker.on('error', (e) => this.guard(() => this.onRecognizeDeath(slot, isThreadOom(e))))
    worker.on('exit', () => this.guard(() => this.onRecognizeDeath(slot, false)))
    void this.engineModule.then(
      (engine) => {
        if (!slot.dead)
          worker.postMessage({ type: 'init', engine: engine.assets } satisfies ToRecognize)
      },
      () => {}
    )
    return slot
  }

  private startRecognize(slot: RecognizeSlot, t: Task, big: boolean): void {
    const data = t.bitmap
    const raster = t.raster
    if (!data || !raster) return
    t.state = 'recognizing'
    t.bitmap = null // ownership moves with the transfer
    t.job.progressDirty = true
    slot.task = t
    slot.big = big
    slot.watchdog = setTimeout(
      () => this.guard(() => this.onRecognizeHang(slot)),
      recognizeWatchdogMs(raster.width * raster.height)
    )
    const msg: ToRecognize = {
      type: 'recognize',
      taskId: t.id,
      width: raster.width,
      height: raster.height,
      dpi: raster.dpi,
      data,
      langs: t.job.langs
    }
    if (slot.ready) slot.worker.postMessage(msg, [data])
    else slot.outbox.push({ msg, transfer: [data] })
  }

  private onRecognize(slot: RecognizeSlot, m: FromRecognize): void {
    if (slot.dead) return
    slot.tripwire = m.tripwire
    if (m.type === 'ready') {
      slot.ready = true
      this.startFailures.recognize = 0
      for (const f of m.selfCheckFailed) this.threadSelfCheckFailed.add(`recognize:${f}`)
      for (const o of slot.outbox.splice(0)) slot.worker.postMessage(o.msg, o.transfer)
      return
    }
    const t = slot.task
    if (!t || t.id !== m.taskId) return
    if (slot.watchdog) clearTimeout(slot.watchdog)
    slot.watchdog = null
    slot.task = null
    if (m.type === 'result') {
      slot.pages++
      const raster = t.raster!
      let page: PackedOcrPage | null = null
      try {
        page = this.toPage(t, m.result)
      } catch {
        // A mapping bug or an impossible engine result: this page fails, the thread is fine.
        page = null
      }
      if (page)
        this.finalize(t, {
          status: page.status,
          renderDpi: raster.dpi,
          raster: { width: raster.width, height: raster.height },
          recognition: page
        })
      else this.fail(t, 'failed', 'recognize-crash')
      // The WASM heap never shrinks: recycle after 50 pages, or after any page over 12 MP.
      if (slot.pages >= this.b.recyclePages || slot.big) this.retireRecognizer(slot)
      slot.big = false
    } else {
      this.retireRecognizer(slot)
      this.recognizeFailure(t, isOomShaped(m.name, m.message))
    }
    this.pump()
  }

  /**
   * A thread's RawOcr → the packed OcrPage in the overlay frame (map.ts). The raster covers the
   * request's page frame exactly (the raster thread checked it against PDFium's), so the frame
   * and the raster size give the mapping.
   */
  private toPage(t: Task, outcome: RecognizeOutcome): PackedOcrPage {
    const raster = t.raster!
    const langs = t.job.langs
    const hashes = this.engine?.dataHashes ?? {}
    const dataHashes: Record<string, string> = {}
    for (const l of langs) if (Object.hasOwn(hashes, l)) dataHashes[l] = hashes[l]
    return mapRawOcr(outcome.raw, {
      page: { width: t.req.width, height: t.req.height },
      raster: { width: raster.width, height: raster.height },
      renderDpi: raster.dpi,
      engineId: ENGINE_ID,
      dataHashes,
      langs,
      pipelineVersion: PIPELINE_VERSION,
      // Triage (PR4b) classifies pages; until the renderer sends a class, a page sent for
      // recognition is treated as a scan.
      pageClass: 'scanned',
      calibration: TESS_CORE7_PLACEHOLDER
    })
  }

  private recognizeFailure(t: Task, oom: boolean): void {
    if (oom) this.localDivisor *= 2
    if (!this.tasks.has(t)) return
    t.recognizeFailures++
    if (t.recognizeFailures >= 2) this.fail(t, 'failed', 'recognize-crash')
    else this.requeue(t) // the bitmap went with the thread: render again
  }

  private onRecognizeHang(slot: RecognizeSlot): void {
    if (slot.dead) return
    // Never answered init, let alone the page: it hung before it started.
    if (!slot.ready) this.startFailures.recognize++
    slot.watchdog = null
    const t = slot.task
    slot.task = null
    this.retireRecognizer(slot)
    if (t) this.fail(t, 'timeout', 'watchdog')
    this.pump()
  }

  private onRecognizeDeath(slot: RecognizeSlot, oom: boolean): void {
    if (slot.dead) return
    if (!slot.ready) this.startFailures.recognize++
    const t = slot.task
    slot.task = null
    this.retireRecognizer(slot)
    // A thread OOM: halve n for the session, re-queue the page once, then `failed`.
    if (t) this.recognizeFailure(t, oom)
    else if (oom) this.localDivisor *= 2
    this.pump()
  }

  private retireRecognizer(slot: RecognizeSlot): void {
    if (slot.dead) return
    slot.dead = true
    if (slot.watchdog) clearTimeout(slot.watchdog)
    slot.watchdog = null
    const i = this.recognizers.indexOf(slot)
    if (i >= 0) this.recognizers.splice(i, 1)
    this.retiredTripwire.recognize += slot.tripwire
    void slot.worker.terminate()
  }

  /**
   * A slot still starting whose task was cancelled: its page never left the outbox, so take it
   * back and keep the thread for the next page instead of paying for another start.
   */
  private unassign(slot: RecognizeSlot): void {
    if (slot.watchdog) clearTimeout(slot.watchdog)
    slot.watchdog = null
    slot.outbox = slot.outbox.filter((o) => o.msg.type !== 'recognize')
    slot.task = null
    slot.big = false
  }

  // -------------------------------------------------------------------------------------------
  // Progress, activity, heartbeat.

  private scheduleFlush(): void {
    if (this.disposed) return
    // Busy ↔ idle transitions go to main at once (the power blocker and the taskbar follow them);
    // counts within a batch ride the throttled flush.
    const busy = this.jobs.size > 0
    if (busy !== this.lastActivity.startsWith('true')) this.reportActivity()
    if (this.flushTimer) return
    const wait = this.lastFlush + this.b.progressIntervalMs - Date.now()
    if (wait <= 0) {
      this.flush()
      return
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.guard(() => this.flush())
    }, wait)
  }

  private flush(): void {
    this.lastFlush = Date.now()
    const now = Date.now()
    for (const job of this.jobs.values()) {
      if (!job.progressDirty) continue
      let inflight = 0
      for (const t of job.tasks)
        if (t.state !== 'queued' && t.startedAt > 0)
          inflight += Math.min(0.95, (now - t.startedAt) / this.expectedPageMs)
      job.progressDirty = false
      this.toRenderer({
        progress: {
          jobId: job.jobId,
          doneOrFailed: job.done + job.failed,
          total: job.total,
          inflightFrac: Math.min(inflight, job.total)
        }
      })
    }
    this.reportActivity()
  }

  private reportActivity(): void {
    let done = 0
    let total = 0
    for (const job of this.jobs.values()) {
      done += job.done + job.failed
      total += job.total
    }
    const busy = this.jobs.size > 0
    const key = `${busy}:${done}:${total}`
    if (key === this.lastActivity) return
    this.lastActivity = key
    this.toParent({ activity: { busy, done, total } })
  }

  private postHeartbeat(): void {
    if (this.disposed) return
    const hb: Heartbeat = {
      tripwire: this.tripwireCounts(),
      tripwireIntact: this.deps.tripwireIntact() && this.threadSelfCheckFailed.size === 0,
      rss: Math.max(0, Math.round(this.deps.rss())),
      threads: { raster: this.raster ? 1 : 0, recognize: this.recognizers.length },
      pending: this.tasks.size,
      concurrency: this.concurrency()
    }
    this.toParent({ heartbeat: hb })
  }

  private tripwireCounts(): Heartbeat['tripwire'] {
    return {
      process: this.deps.tripwire(),
      raster: this.retiredTripwire.raster + (this.raster?.tripwire ?? 0),
      recognize:
        this.retiredTripwire.recognize + this.recognizers.reduce((a, s) => a + s.tripwire, 0)
    }
  }
}
