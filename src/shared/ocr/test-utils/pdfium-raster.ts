// Rasterise a PDF page to 8-bit grey with PDFium WASM (@embedpdf/pdfium). Test-only, DOM-free and
// Node-free: the caller hands in an initialised module (see `node-deps.ts` for the Node loader), so
// this file never touches the filesystem. A WASM rasteriser gives the same pixels on every OS,
// unlike native canvases with platform hinting (DESIGN.md §3.9.1 step 2).

import type { GreyImage } from './degrade'

/** The PDFium calls this rasteriser needs (a structural subset of `@embedpdf/pdfium`'s module). */
export interface PdfiumRenderModule {
  FPDF_LoadMemDocument(ptr: number, size: number, password: string): number
  FPDF_CloseDocument(doc: number): void
  FPDF_LoadPage(doc: number, index: number): number
  FPDF_ClosePage(page: number): void
  FPDF_GetPageWidthF(page: number): number
  FPDF_GetPageHeightF(page: number): number
  FPDFBitmap_CreateEx(w: number, h: number, format: number, first: number, stride: number): number
  FPDFBitmap_FillRect(bmp: number, l: number, t: number, w: number, h: number, c: number): boolean
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
  pdfium: { HEAPU8: Uint8Array; wasmExports: { malloc(n: number): number; free(p: number): void } }
}

/**
 * Renders page `pageIndex` of `pdf` at `dpi` to an 8-bit grey raster (top-left origin). `flags`
 * are FPDF_RenderPageBitmap flags (default 0).
 */
export type Rasterizer = (
  pdf: Uint8Array,
  dpi: number,
  pageIndex?: number,
  flags?: number
) => GreyImage

const FPDFBitmap_BGRA = 4
/** FPDF_RenderPageBitmap flags: aliased (monochrome) text, and the print path. */
export const FPDF_RENDER_NO_SMOOTHTEXT = 0x1000
export const FPDF_PRINTING = 0x800

/**
 * A rasteriser over an initialised PDFium module: BGRA render onto opaque white (by default no
 * flags: PDFium's anti-aliased path, no LCD text), then integer BT.601 luma
 * (77R + 150G + 29B + 128) >> 8, which is exact for neutral greys. The bitmap is page size ×
 * dpi / 72, rounded.
 */
export function createPdfiumRasterizer(mod: PdfiumRenderModule): Rasterizer {
  return (pdf, dpi, pageIndex = 0, flags = 0) => {
    const rt = mod.pdfium
    const ptr = rt.wasmExports.malloc(pdf.length)
    rt.HEAPU8.set(pdf, ptr)
    const doc = mod.FPDF_LoadMemDocument(ptr, pdf.length, '')
    try {
      if (!doc) throw new Error('PDFium could not open the document')
      const page = mod.FPDF_LoadPage(doc, pageIndex)
      if (!page) throw new Error(`PDFium could not load page ${pageIndex}`)
      try {
        const w = Math.round((mod.FPDF_GetPageWidthF(page) * dpi) / 72)
        const h = Math.round((mod.FPDF_GetPageHeightF(page) * dpi) / 72)
        const bmp = mod.FPDFBitmap_CreateEx(w, h, FPDFBitmap_BGRA, 0, 0)
        if (!bmp) throw new Error('PDFium could not allocate the bitmap')
        try {
          mod.FPDFBitmap_FillRect(bmp, 0, 0, w, h, 0xffffffff)
          mod.FPDF_RenderPageBitmap(bmp, page, 0, 0, w, h, 0, flags)
          const buf = mod.FPDFBitmap_GetBuffer(bmp)
          const stride = mod.FPDFBitmap_GetStride(bmp)
          const heap = rt.HEAPU8
          const data = new Uint8Array(w * h)
          for (let y = 0; y < h; y++) {
            let p = buf + y * stride
            for (let x = 0; x < w; x++, p += 4)
              data[y * w + x] = (29 * heap[p] + 150 * heap[p + 1] + 77 * heap[p + 2] + 128) >> 8
          }
          return { width: w, height: h, data }
        } finally {
          mod.FPDFBitmap_Destroy(bmp)
        }
      } finally {
        mod.FPDF_ClosePage(page)
      }
    } finally {
      if (doc) mod.FPDF_CloseDocument(doc)
      rt.wasmExports.free(ptr)
    }
  }
}
