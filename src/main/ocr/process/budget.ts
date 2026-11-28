// Memory and concurrency budgets for the utility process (DESIGN.md §3.3.3). Pure functions and
// constants; every number is injectable so tests can drive the scheduler with tiny budgets.

import type { OcrHostLimits } from '../../../shared/ocr/protocol'
import { DEFAULT_RASTER_LIMITS } from './raster-core'
import type { RasterLimits } from './thread-messages'

const MiB = 2 ** 20
const GiB = 2 ** 30

export interface Budgets {
  /** RSS budget per recognize thread, pages ≤ 12 MP and ≤ 3 languages (PR0: 126–183 MB measured). */
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

export const DEFAULT_BUDGETS: Budgets = {
  perWorker: 256 * MiB,
  perWorkerBig: 384 * MiB,
  baseline: 96 * MiB,
  maxThreads: 4,
  bigPagePixels: 12_000_000,
  recyclePages: 50,
  sourceBudget: 1 * GiB,
  rasterRecycleHeap: 1.2 * GiB,
  raster: DEFAULT_RASTER_LIMITS,
  progressIntervalMs: 100,
  heartbeatIntervalMs: 5000
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
