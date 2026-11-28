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

export interface RasterLimits {
  /** The PDFium WASM memory cap (the module declares 32,768 pages = 2 GiB; PR0). */
  heapCap: number
  /** Close and reopen a document whose heap growth since it was opened exceeds this (§3.3.3). */
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

export type FromRaster =
  | { type: 'ready'; tripwire: number }
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
  | { type: 'ready'; tripwire: number }
  | { type: 'result'; taskId: number; result: StubRecognition; tripwire: number }
  | { type: 'error'; taskId: number; name: string; message: string; tripwire: number }
