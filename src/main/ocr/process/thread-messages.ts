// Messages between the coordinator (the utility process's main thread) and its worker_threads.
// Internal to src/main/ocr/process: both ends are our code in the same process, so these are typed
// but not schema-checked the way the renderer and main links are (src/shared/ocr/protocol.ts).
//
// Unlike the MessagePortMain links, worker_threads ports DO support transfer lists, and bitmaps
// move raster → coordinator → recognize as transferred ArrayBuffers (zero-copy; §3.3.1 step 4).
// Source bytes are shared, not transferred: the coordinator keeps each source in a
// SharedArrayBuffer so a recycled or crashed raster thread can reopen it without the renderer
// sending the file again.

import type { CalibrationTable } from '../../../shared/ocr/engine/types'
import type { Orientation } from '../../../shared/ocr/preprocess/orientation'
import type { PageReason } from '../../../shared/ocr/protocol'
import type { TriagePage } from '../../../shared/ocr/triage'
import type { RecognizeOutcome, ReuseHint } from './recognize-core'
import type { TessParams } from '../../../shared/ocr/engine/tess-core'

export interface RasterLimits {
  /** The PDFium WASM memory cap (the module declares 32,768 pages = 2 GiB; PR0). */
  heapCap: number
  /**
   * Close and reopen a document once the file bytes PDFium has read since it was opened exceed this
   * (§3.3.3; raster-core.ts says why it is not measured as heap growth).
   */
  reopenWatermark: number
  /** Headroom the probe asks for on top of the bitmap, for image decode buffers. */
  decodeAllowance: number
  /** Pixel caps (§3.3.3): long side and area. A page over either is rendered at a lower DPI. */
  maxLongSide: number
  maxPixels: number
}

export type ToRaster =
  | { type: 'init'; pdfium: WebAssembly.Module; limits: RasterLimits }
  /** Register a source; with `count`, also open it now and answer `opened`. */
  | { type: 'open'; src: string; data: SharedArrayBuffer; count: boolean }
  | { type: 'close'; src: string }
  | {
      type: 'render'
      taskId: number
      src: string
      index: number
      dpi: number
      userUnit: number
      frame: { width: number; height: number }
      /** Render flags beyond 0 (only FPDF_RENDER_NO_SMOOTHIMAGE; page-plan.ts). */
      flags?: number
      /** A near-scanned page: render without its visible native text (§3.4.1). */
      maskText?: boolean
    }
  /** Triage these pages of `src` (§3.4.1); answered by one `triaged` (or `triage-failed`). */
  | { type: 'triage'; taskId: number; src: string; pages: number[] }

/**
 * `ready` carries the thread's own tripwire self-check: the escape hatches that did NOT trip in its
 * realm (no-network.ts `tripwireSelfCheck`; empty when all is well).
 */
export type FromRaster =
  | { type: 'ready'; tripwire: number; selfCheckFailed: string[] }
  | { type: 'opened'; src: string; pageCount: number; tripwire: number }
  | { type: 'open-failed'; src: string; pdfiumError: number; tripwire: number }
  | {
      type: 'rendered'
      taskId: number
      width: number
      height: number
      dpi: number
      data: ArrayBuffer
      heap: number
      tripwire: number
    }
  | {
      type: 'render-failed'
      taskId: number
      status: 'failed' | 'too-large'
      reason: PageReason
      heap: number
      tripwire: number
    }
  /**
   * PDFium printed "Cannot enlarge memory" during this render (the silent-blank case, §3.3.4), or
   * the headroom probe found no room. The bitmap, if any, was discarded inside the thread.
   */
  | { type: 'heap-exhausted'; taskId: number; heap: number; tripwire: number }
  | { type: 'triaged'; taskId: number; pages: TriagePage[]; heap: number; tripwire: number }
  /** PDFium could not open the source for triage (its FPDF_GetLastError code). */
  | { type: 'triage-failed'; taskId: number; pdfiumError: number; tripwire: number }
  /** A RuntimeError (trap or abort) or any other throw: the module is never trusted again. */
  | { type: 'fatal'; taskId: number | null; error: string; tripwire: number }

/**
 * What a recognize thread needs to build engines: the coordinator's compiled core (one artifact,
 * SHA-checked once), the directory holding the glue (the thread checks the glue's SHA itself, right
 * before it require()s it) and each verified .traineddata.gz, shared without a copy.
 */
export interface EngineAssets {
  module: WebAssembly.Module
  coreDir: string
  data: Record<string, SharedArrayBuffer>
}

export type ToRecognize =
  | { type: 'init'; engine: EngineAssets }
  /**
   * More verified languages for a live thread (PR9: a download or Install from file… finished).
   * Merged into its assets; an engine is only ever built for the languages a page asks for.
   */
  | { type: 'add-data'; data: Record<string, SharedArrayBuffer> }
  | {
      type: 'recognize'
      taskId: number
      width: number
      height: number
      dpi: number
      data: ArrayBuffer
      langs: string[]
      /** The adaptive second call (§3.4.3): reuse the first call's geometry and recipe. */
      reuse?: ReuseHint
      /** Ask for the adaptive pass (default true). */
      adaptive?: boolean
      /** PROTOTYPE, tests only: never split a pass (the 1.1.4 path, for an A/B). */
      noUnits?: boolean
      /**
       * The page's edit rotation (§3.4.5 priors: tried first). Absent = 0: the 90° test decides.
       */
      editRotation?: Orientation
      /**
       * Tests only (the calibration run): the table the pipeline's own gates (Retry A) read, so a
       * refit is not fed by the table it replaces. Default: the shipped TESS_CORE7.
       */
      calibration?: CalibrationTable
      /** Tests only: pass 1 on the bitmap as given, no preprocessing (the PR5 replay cache). */
      rawPass1?: boolean
      /** PROTOTYPE: hand a split pass's units to the parent ('units' / 'units-done'). */
      delegateUnits?: boolean
      /**
       * Tests only (the tier-1 harness records the replay cache): also return each pass's raw hOCR.
       * The coordinator never sets it; hOCR is page content and never leaves the process.
       */
      returnHocr?: boolean
    }
  /** PROTOTYPE: recognise one unit as given (helper side). */
  | {
      type: 'unit'
      taskId: number
      width: number
      height: number
      data: ArrayBuffer
      langs: string[]
      params: TessParams
    }
  /** PROTOTYPE: every unit of the page task's split pass, in order. */
  | { type: 'units-done'; taskId: number; hocr: string[] }

export type FromRecognize =
  | { type: 'ready'; tripwire: number; selfCheckFailed: string[] }
  | {
      type: 'result'
      taskId: number
      result: RecognizeOutcome
      /** WASM heap after the page (it only grows; §3.3.3). */
      heap: number
      /** Engine stderr lines during the page (counted, never forwarded: they can carry content). */
      stderrLines: number
      tripwire: number
    }
  | { type: 'error'; taskId: number; name: string; message: string; tripwire: number }
  /** PROTOTYPE: a split pass's units, for the parent to place on threads. */
  | {
      type: 'units'
      taskId: number
      jobs: { width: number; height: number; data: ArrayBuffer; params: TessParams }[]
      tripwire: number
    }
  | { type: 'unit-result'; taskId: number; hocr: string; tripwire: number }
