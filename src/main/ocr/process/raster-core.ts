// The raster thread's PDFium logic, kept free of worker_threads so it is unit-testable in-process
// with the real WASM (raster-core.node.test.ts). raster-thread.ts is the thin message loop around it.
//
// DESIGN.md §3.3.1 step 3, §3.3.3, §3.3.4, §3.4.2:
// - Documents open with FPDF_LoadCustomDocument and a getBlock callback over a JS-side buffer, so
//   the file is never copied into the 2 GiB WASM heap. The callback re-reads HEAPU8 on every call
//   (heap growth replaces the view).
// - Render: FPDFBitmap_Gray, FillRect white, FPDF_RenderPageBitmap(rotate 0, flags 0). FPDF_ANNOT is
//   left out on purpose, so widget values, stamps and signature appearances never become page text.
// - The frame (intrinsic /Rotate applied, view box = CropBox ∩ MediaBox) must equal the pdf.js
//   PageEntry frame the renderer sent; a mismatch fails the page instead of misplacing text.
// - PDFium keeps the stored bytes of every stream it touched until the document closes, so a
//   document is closed and reopened before a render once the bytes its getBlock callback has served
//   since it was opened pass the reopen watermark. That sum is an upper bound on what the document
//   can be holding. (DESIGN.md §3.3.3 words the watermark as heap growth; but after the first
//   reopen PDFium reuses the memory it freed without growing HEAPU8, so heap growth lets every
//   cycle retain more than the last, measured in review: gaps of 22, 33, 40, 49 pages.)
// - Headroom probe: malloc(bitmap + decode allowance) and free it again. Past the cap malloc returns
//   0 without aborting (PR0), so this is a cheap, safe test.
// - Silent-blank guard: near the cap PDFium can print "Cannot enlarge memory" and still return an
//   all-white bitmap (PR0). Any such line during a render discards the bitmap.
// - Anything that throws out of the module (a WebAssembly.RuntimeError trap or abort) propagates;
//   the thread reports it and is never trusted again.

import type { PageReason } from '../../../shared/ocr/protocol'
import { fitRaster, type TriagePage } from '../../../shared/ocr/triage'
import type { RasterLimits } from './thread-messages'
import { jpxRefusalOf, triagePages, type PdfiumTriage, type TriageContext } from './triage-pdfium'

/** The PDFium calls this module needs (a structural subset of `@embedpdf/pdfium`'s wrapper). */
export interface PdfiumRaster {
  FPDF_LoadCustomDocument(fileAccess: number, password: string): number
  FPDF_GetLastError(): number
  FPDF_CloseDocument(doc: number): void
  FPDF_GetPageCount(doc: number): number
  FPDF_LoadPage(doc: number, index: number): number
  FPDF_ClosePage(page: number): void
  FPDF_GetPageWidthF(page: number): number
  FPDF_GetPageHeightF(page: number): number
  FPDFBitmap_CreateEx(w: number, h: number, format: number, first: number, stride: number): number
  FPDFBitmap_FillRect(bmp: number, l: number, t: number, w: number, h: number, c: number): unknown
  FPDF_RenderPageBitmap(
    bmp: number,
    page: number,
    x: number,
    y: number,
    w: number,
    h: number,
    rotate: number,
    flags: number
  ): void
  FPDFBitmap_GetBuffer(bmp: number): number
  FPDFBitmap_GetStride(bmp: number): number
  FPDFBitmap_Destroy(bmp: number): void
  pdfium: {
    HEAPU8: Uint8Array
    wasmExports: { malloc(n: number): number; free(p: number): void }
    addFunction(fn: (...args: number[]) => number, sig: string): number
    removeFunction(ptr: number): void
    setValue(ptr: number, value: number, type: string): void
  }
}

export const FPDFBitmap_Gray = 1
/** Render flags: 0. Not FPDF_ANNOT (0x01); and 0x10 is FPDF_REVERSE_BYTE_ORDER, not printing (PR0). */
export const RENDER_FLAGS = 0

export const DEFAULT_RASTER_LIMITS: RasterLimits = {
  heapCap: 2 * 2 ** 30,
  reopenWatermark: 512 * 2 ** 20,
  decodeAllowance: 64 * 2 ** 20,
  maxLongSide: 7200,
  maxPixels: 36_000_000
}

/** pdf.js and PDFium agree to float32 precision on the frame (PR0: exactly, on 12 cases). */
const FRAME_TOLERANCE_PT = 1e-3

export interface RenderRequest {
  src: string
  index: number
  dpi: number
  userUnit: number
  frame: { width: number; height: number }
}

export type RenderOutcome =
  | { kind: 'ok'; width: number; height: number; dpi: number; data: Uint8Array }
  | { kind: 'failed'; status: 'failed' | 'too-large'; reason: PageReason }
  | { kind: 'heap-exhausted' }

interface OpenDoc {
  doc: number
  fileAccess: number
  getBlock: number
  /** Bytes the getBlock callback has copied into the heap since this open. */
  served: { bytes: number }
}

interface Source {
  bytes: Uint8Array
  open: OpenDoc | null
}

const ENLARGE_RE = /Cannot enlarge memory/

/**
 * The DPI and size a page renders at once the pixel caps are applied (DPI only ever goes down).
 * It lives in src/shared/ocr/triage.ts since PR4b: triage's DPI selection (§3.4.3) must cap
 * exactly the way the render does.
 */
export { fitRaster }

/**
 * The `printErr` the raster thread hands PDFium's Emscripten glue: every line goes to the engine's
 * `noteStderr` once it exists (lines from before, during init, are kept in `early` for it). This is
 * the silent-blank guard's only input, so it is a function here and tested, not inline wiring.
 */
export function makePrintErr(
  engine: () => RasterEngine | null,
  early: string[]
): (line: string) => void {
  return (line) => {
    const e = engine()
    if (e) e.noteStderr(String(line))
    else early.push(String(line))
  }
}

export class RasterEngine {
  private readonly sources = new Map<string, Source>()
  private rendering = false
  private enlargeDuringRender = false
  /** The last few PDFium stderr lines, kept in memory only (they can quote document data). */
  readonly stderrTail: string[] = []

  constructor(
    private readonly mod: PdfiumRaster & PdfiumTriage,
    private readonly limits: RasterLimits = DEFAULT_RASTER_LIMITS
  ) {}

  /** Feed every PDFium `printErr` line here. Never silenced: this is the silent-blank detector. */
  noteStderr(line: string): void {
    if (this.stderrTail.length >= 20) this.stderrTail.shift()
    this.stderrTail.push(line.slice(0, 300))
    if (this.rendering && ENLARGE_RE.test(line)) this.enlargeDuringRender = true
  }

  heapBytes(): number {
    return this.mod.pdfium.HEAPU8.length
  }

  /** Register a source's bytes (a view over the coordinator's SharedArrayBuffer). */
  attach(src: string, bytes: Uint8Array): void {
    this.close(src)
    this.sources.set(src, { bytes, open: null })
  }

  has(src: string): boolean {
    return this.sources.has(src)
  }

  /** Open (if needed) and return the page count, or the PDFium error code on failure. */
  pageCount(src: string): { pageCount: number } | { pdfiumError: number } {
    const s = this.sources.get(src)
    if (!s) return { pdfiumError: -1 }
    const doc = this.ensureOpen(s)
    if (typeof doc !== 'number') return doc
    return { pageCount: this.mod.FPDF_GetPageCount(doc) }
  }

  close(src: string): void {
    const s = this.sources.get(src)
    if (!s) return
    this.closeDoc(s)
    this.sources.delete(src)
  }

  closeAll(): void {
    for (const src of [...this.sources.keys()]) this.close(src)
  }

  /**
   * Triage `pages` of `src` (§3.4.1): PDFium signals and the class, render DPI and native words of
   * every page, without rendering anything. PDFium's open error code when the source cannot open.
   */
  triage(
    src: string,
    pages: readonly number[],
    onSignals?: TriageContext['onSignals']
  ): TriagePage[] | { pdfiumError: number } {
    const s = this.sources.get(src)
    if (!s) return { pdfiumError: -1 }
    // Triage reads content streams (and JPX image data), which PDFium retains like a render's.
    if (s.open && s.open.served.bytes > this.limits.reopenWatermark) this.closeDoc(s)
    const doc = this.ensureOpen(s)
    if (typeof doc !== 'number') return doc
    return triagePages(this.mod, doc, pages, {
      file: s.bytes,
      caps: { maxLongSide: this.limits.maxLongSide, maxPixels: this.limits.maxPixels },
      onSignals
    })
  }

  render(req: RenderRequest): RenderOutcome {
    const s = this.sources.get(req.src)
    if (!s) return { kind: 'failed', status: 'failed', reason: 'render' }
    if (req.userUnit !== 1) return { kind: 'failed', status: 'failed', reason: 'user-unit' }

    // Reopen watermark: drop the stream bytes PDFium retained for this document so far.
    if (s.open && s.open.served.bytes > this.limits.reopenWatermark) this.closeDoc(s)
    const doc = this.ensureOpen(s)
    if (typeof doc !== 'number') return { kind: 'failed', status: 'failed', reason: 'render' }
    if (req.index >= this.mod.FPDF_GetPageCount(doc))
      return { kind: 'failed', status: 'failed', reason: 'page-missing' }

    const m = this.mod
    this.rendering = true
    this.enlargeDuringRender = false
    let page = 0
    let bmp = 0
    try {
      page = m.FPDF_LoadPage(doc, req.index)
      if (!page) return { kind: 'failed', status: 'failed', reason: 'render' }
      const pw = m.FPDF_GetPageWidthF(page)
      const ph = m.FPDF_GetPageHeightF(page)
      if (
        Math.abs(pw - req.frame.width) > FRAME_TOLERANCE_PT ||
        Math.abs(ph - req.frame.height) > FRAME_TOLERANCE_PT
      )
        return { kind: 'failed', status: 'failed', reason: 'frame-mismatch' }
      // Never hand PDFium a JPX image it decodes wrongly or traps on (§3.4.1's SIZ pre-check).
      if (jpxRefusalOf(m, page, s.bytes))
        return { kind: 'failed', status: 'failed', reason: 'image-format' }

      const fit = fitRaster(pw, ph, req.dpi, this.limits)
      const need = fit.width * fit.height + this.limits.decodeAllowance
      if (!this.probeHeadroom(need)) return { kind: 'heap-exhausted' }
      // The probe's own failure prints "Cannot enlarge memory" too; only lines from here on count.
      this.enlargeDuringRender = false

      bmp = m.FPDFBitmap_CreateEx(fit.width, fit.height, FPDFBitmap_Gray, 0, 0)
      if (!bmp) return { kind: 'heap-exhausted' }
      m.FPDFBitmap_FillRect(bmp, 0, 0, fit.width, fit.height, 0xffffffff)
      m.FPDF_RenderPageBitmap(bmp, page, 0, 0, fit.width, fit.height, 0, RENDER_FLAGS)
      if (this.enlargeDuringRender) return { kind: 'heap-exhausted' }

      const stride = m.FPDFBitmap_GetStride(bmp)
      const buf = m.FPDFBitmap_GetBuffer(bmp)
      const heap = m.pdfium.HEAPU8
      const data = new Uint8Array(fit.width * fit.height)
      if (stride === fit.width) data.set(heap.subarray(buf, buf + data.length))
      else
        for (let y = 0; y < fit.height; y++)
          data.set(heap.subarray(buf + y * stride, buf + y * stride + fit.width), y * fit.width)
      if (this.enlargeDuringRender) return { kind: 'heap-exhausted' }
      return { kind: 'ok', width: fit.width, height: fit.height, dpi: fit.dpi, data }
    } finally {
      this.rendering = false
      if (bmp) m.FPDFBitmap_Destroy(bmp)
      if (page) m.FPDF_ClosePage(page)
    }
  }

  /** Can the heap still hold `bytes` more? A malloc/free probe; past the cap malloc returns 0. */
  private probeHeadroom(bytes: number): boolean {
    // More than the whole heap can ever hold: no probe needed (and none that could grow it).
    if (bytes >= this.limits.heapCap) return false
    // Free space already inside the heap counts, which is why this asks malloc instead of
    // comparing against `heapCap - HEAPU8.length`.
    const ex = this.mod.pdfium.wasmExports
    const p = ex.malloc(bytes)
    if (!p) return false
    ex.free(p)
    return true
  }

  private ensureOpen(s: Source): number | { pdfiumError: number } {
    if (s.open) return s.open.doc
    const rt = this.mod.pdfium
    const bytes = s.bytes
    const len = bytes.length
    const served = { bytes: 0 }
    const getBlock = rt.addFunction(
      (_param: number, position: number, pBuf: number, size: number) => {
        position >>>= 0
        pBuf >>>= 0
        size >>>= 0
        if (position + size > len) return 0
        // Re-read HEAPU8 on every call: heap growth replaces the view.
        rt.HEAPU8.set(bytes.subarray(position, position + size), pBuf)
        served.bytes += size
        return 1
      },
      'iiiii'
    )
    // FPDF_FILEACCESS on wasm32: { u32 m_FileLen; fnptr m_GetBlock; void* m_Param } = 12 bytes.
    const fa = rt.wasmExports.malloc(12)
    if (!fa) {
      rt.removeFunction(getBlock)
      return { pdfiumError: -2 }
    }
    rt.setValue(fa, len, 'i32')
    rt.setValue(fa + 4, getBlock, 'i32')
    rt.setValue(fa + 8, 0, 'i32')
    const doc = this.mod.FPDF_LoadCustomDocument(fa, '')
    if (!doc) {
      const err = this.mod.FPDF_GetLastError()
      rt.wasmExports.free(fa)
      rt.removeFunction(getBlock)
      return { pdfiumError: err }
    }
    s.open = { doc, fileAccess: fa, getBlock, served }
    return doc
  }

  private closeDoc(s: Source): void {
    if (!s.open) return
    const rt = this.mod.pdfium
    this.mod.FPDF_CloseDocument(s.open.doc)
    rt.wasmExports.free(s.open.fileAccess)
    rt.removeFunction(s.open.getBlock)
    s.open = null
  }
}
