// Memory and concurrency budgets for the utility process (DESIGN.md §3.3.3). Pure functions and
// constants; every number is injectable so tests can drive the scheduler with tiny budgets.

import type { ResourceLimits } from 'node:worker_threads'

import { OCR_HEARTBEAT_INTERVAL_MS, type OcrHostLimits } from '../../../shared/ocr/protocol'
import { DEFAULT_RASTER_LIMITS } from './raster-core'
import type { RasterLimits } from './thread-messages'

const MiB = 2 ** 20
const GiB = 2 ** 30

export interface Budgets {
  /** RSS budget per recognize thread, pages ≤ 12 MP and ≤ 3 languages (see `perWorkerBudget`). */
  perWorker: number
  /** Budget for the one solo page > 12 MP (PR0: 290–343 MB at 34.8 MP). */
  perWorkerBig: number
  /** The utility process before any thread (PR0: 62–88 MB). */
  baseline: number
  maxThreads: number
  /** Pages above this run one at a time and recycle their thread afterwards. */
  bigPagePixels: number
  /** Recycle a recognize thread after this many pages. */
  recyclePages: number
  /** Σ source bytes kept open (JS-side SharedArrayBuffers). One larger source still opens, alone. */
  sourceBudget: number
  /** Recycle the raster thread between documents once its heap passes this. */
  rasterRecycleHeap: number
  raster: RasterLimits
  /** Progress and activity events at most this often. */
  progressIntervalMs: number
  heartbeatIntervalMs: number
}

/**
 * PER_WORKER by platform. DESIGN.md says the constant "may only go up" when a measurement breaches
 * it; PR0b did on Linux:
 * - win32 256 MiB: best_int, n = 1, 122.6–162.0 MiB per thread [measured, PR0b run 1, Windows].
 * - linux / darwin 320 MiB: Ubuntu p6 at n = 1 reached 255.9 MiB, and the single-thread delta grows
 *   with run length (229.3 MiB over 10 pages vs 190.6 over 4); macOS reached 234 MiB [measured,
 *   PR0b run 1]. 320 is also what the adaptive 462-DPI page peaked at on Ubuntu (317.5 MiB).
 * - Any other platform gets the larger figure: unmeasured, so the conservative one.
 */
export function perWorkerBudget(platform: string): number {
  return platform === 'win32' ? 256 * MiB : 320 * MiB
}

/** The §3.3.3 budgets for `platform` (the utility process passes its own). */
export function defaultBudgets(platform: string = process.platform): Budgets {
  return {
    perWorker: perWorkerBudget(platform),
    // Unchanged by PR0b: the adaptive 20.6 MP pass peaked at 256.4 / 317.5 / 306.5 MiB.
    perWorkerBig: 384 * MiB,
    baseline: 96 * MiB,
    maxThreads: 4,
    bigPagePixels: 12_000_000,
    recyclePages: 50,
    sourceBudget: 1 * GiB,
    rasterRecycleHeap: 1.2 * GiB,
    raster: DEFAULT_RASTER_LIMITS,
    progressIntervalMs: 100,
    // Main's liveness check expects exactly this period (supervisor.ts).
    heartbeatIntervalMs: OCR_HEARTBEAT_INTERVAL_MS
  }
}

export const DEFAULT_BUDGETS: Budgets = defaultBudgets()

/**
 * V8 heap caps for EVERY worker_thread the coordinator starts (raster and recognize). Without them
 * a JS-heap OOM in a thread is not a thread error: PR0b measured, in a utility process, Windows
 * killing the whole process (exit 134, child-process-gone 'crashed') and Linux hanging it; only
 * macOS (heap limit 2144 MB) got a catchable ERR_WORKER_OUT_OF_MEMORY. With `resourceLimits` set
 * (64 MB in PR0b) every OS gave ERR_WORKER_OUT_OF_MEMORY and the process lived. (`execArgv
 * --max-old-space-size` on the fork is accepted but not honoured: PR0b.)
 *
 * Contained, not every shape: Node lets a capped worker go only 16 MiB past its limit while it stops
 * it, so a runaway of small objects (PR0b's, and the one in threads.node.test.ts) is contained, but
 * one that grows a single big array, Map or backing store needs more than that in one allocation and
 * V8 aborts the WHOLE process ("FATAL ERROR: … JavaScript heap out of memory", exit 134) [measured:
 * Electron 38.8.6 utility process and Node 24.12 with these caps]. The supervisor reads that line off
 * the child's stderr and treats the exit as an OOM (supervisor.ts `isV8FatalOom`).
 *
 * The caps bound the JS heap only. The WASM memories (PDFium's, Tesseract's) and ArrayBuffers are
 * outside it, so they do not constrain the measured workloads (threads.node.test.ts proves 512 MiB
 * of WASM memory plus 256 MiB of buffers under these caps).
 * - maxOldGenerationSizeMb 256: no V8-heap figure was measured on its own, so take the most a thread
 *   could have needed: its whole non-WASM RSS. The largest is Ubuntu p6 at n = 1: 255.9 MiB RSS with
 *   a 61.8 MiB WASM heap, so ≤ 194 MiB [measured, PR0b; the split is an upper bound]. 256 leaves
 *   ≥ 30 % headroom over that, and is 8–16× under the default (2144 / 4096 MB) where the process
 *   died or hung.
 * - maxYoungGenerationSizeMb 48: per-page temporaries are short-lived; Node's worker default is
 *   192 MiB, which on top of the old generation would let one thread's heap reach 448 MiB, past
 *   PER_WORKER_BIG. With 48 the whole heap is capped at 304 MiB [measured: heap_size_limit, Node
 *   24.12].
 * - stackSizeMb 4: Node's default, the one every PR0/PR0b recognition ran with (WASM frames use this
 *   stack, so a smaller one could change what recognises).
 */
export const THREAD_RESOURCE_LIMITS = {
  maxOldGenerationSizeMb: 256,
  maxYoungGenerationSizeMb: 48,
  stackSizeMb: 4
} as const satisfies ResourceLimits

/** The options every `new Worker(entry, …)` in the utility process must pass. */
export function threadOptions(): { resourceLimits: ResourceLimits } {
  return { resourceLimits: { ...THREAD_RESOURCE_LIMITS } }
}

export interface SystemInfo {
  totalmem: number
  /** `process.availableMemory()` (never `os.freemem()`, which is wrong on macOS). */
  availableMemory: number
  /** `os.availableParallelism()`. */
  cpus: number
}

/**
 * Recognize threads to run (§3.3.3):
 *   byCpu = max(1, cpus − 2)   (leave the UI and the raster thread a core)
 *   byMem = max(1, ⌊(min(¼ total, ½ available) − BASELINE) / PER_WORKER⌋)
 *   n = min(4, byCpu, byMem); halved on battery; 1 when thermally throttled; then ÷ divisor (OOM).
 * On a 4-vCPU machine byCpu is 2, which is where PR0b's Windows runner still met the 6 s per-page
 * gate (n = 4 there was 6.79 s per page).
 */
export function concurrency(
  sys: SystemInfo,
  limits: OcrHostLimits,
  b: Pick<Budgets, 'perWorker' | 'baseline' | 'maxThreads'>,
  localDivisor = 1
): number {
  const byCpu = Math.max(1, sys.cpus - 2)
  const byMem = Math.max(
    1,
    Math.floor(
      (Math.min(0.25 * sys.totalmem, 0.5 * sys.availableMemory) - b.baseline) / b.perWorker
    )
  )
  let n = Math.min(b.maxThreads, byCpu, byMem)
  if (limits.onBattery) n = Math.max(1, n >> 1)
  if (limits.thermal === 'serious' || limits.thermal === 'critical' || limits.speedLimit < 80) n = 1
  return Math.max(1, Math.floor(n / (limits.divisor * localDivisor)))
}

/** Recognize watchdog per page: min(180 s, max(60 s, 15 s × MP)) (§3.3.4). */
export function recognizeWatchdogMs(pixels: number): number {
  return Math.round(Math.min(180_000, Math.max(60_000, 15_000 * (pixels / 1e6))))
}

/** Raster watchdog per render: min(60 s, max(15 s, 2 s × MP)) (§3.3.4). */
export function rasterWatchdogMs(pixels: number): number {
  return Math.round(Math.min(60_000, Math.max(15_000, 2_000 * (pixels / 1e6))))
}
