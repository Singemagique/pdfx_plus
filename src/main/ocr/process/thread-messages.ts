// Messages between the coordinator (the utility process's main thread) and its worker_threads.
// Internal to src/main/ocr/process: both ends are our code in the same process, so these are typed
// but not schema-checked the way the renderer and main links are (src/shared/ocr/protocol.ts).
//
// Unlike the MessagePortMain links, worker_threads ports DO support transfer lists, and bitmaps
// move raster → coordinator → recognize as transferred ArrayBuffers (zero-copy; §3.3.1 step 4).
// Source bytes are shared, not transferred: the coordinator keeps each source in a
// SharedArrayBuffer so a recycled or crashed raster thread can reopen it without the renderer
// sending the file again.

import type { PageReason, StubRecognition } from '../../../shared/ocr/protocol'
import type { TriagePage } from '../../../shared/ocr/triage'

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

export type ToRecognize =
  | { type: 'init'; engine: WebAssembly.Module }
  | {
      type: 'recognize'
      taskId: number
      width: number
      height: number
      dpi: number
      data: ArrayBuffer
      langs: string[]
    }

export type FromRecognize =
  | { type: 'ready'; tripwire: number; selfCheckFailed: string[] }
  | { type: 'result'; taskId: number; result: StubRecognition; tripwire: number }
  | { type: 'error'; taskId: number; name: string; message: string; tripwire: number }
