import { describe, expect, it, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PDFDocument, PDFName, PDFString, StandardFonts } from 'pdf-lib'
import { init } from '@embedpdf/pdfium'

import { redactPdf, type PdfiumModule } from './redact'

// The engine only needs the calls in PdfiumModule; the test additionally extracts text, counts
// annotations, and renders to a bitmap to PROVE removal/coverage, so it uses the wider runtime.
interface TestModule extends PdfiumModule {
  FPDFText_LoadPage(page: number): number
  FPDFText_CountChars(textPage: number): number
  FPDFText_GetText(textPage: number, start: number, count: number, buffer: number): number
  FPDFText_ClosePage(textPage: number): void
  FPDFBitmap_Create(width: number, height: number, alpha: number): number
  FPDFBitmap_FillRect(
    bmp: number,
    l: number,
    t: number,
    w: number,
    h: number,
    color: number
  ): boolean
  FPDFBitmap_GetBuffer(bmp: number): number
  FPDFBitmap_GetStride(bmp: number): number
  FPDFBitmap_Destroy(bmp: number): void
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
  pdfium: PdfiumModule['pdfium'] & { UTF16ToString(ptr: number): string }
}

let pdfium: TestModule

beforeAll(async () => {
  const wasmBinary = readFileSync(
    fileURLToPath(
      new URL('../../../../node_modules/@embedpdf/pdfium/dist/pdfium.wasm', import.meta.url)
    )
  )
  const mod = await init({ wasmBinary })
  mod.PDFiumExt_Init()
  pdfium = mod as unknown as TestModule
})

async function makeTextPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([400, 800])
  const font = await doc.embedFont(StandardFonts.Helvetica)
  page.drawText('PUBLIC line one', { x: 50, y: 750, size: 18, font })
  page.drawText('SECRET-9X42 confidential', { x: 50, y: 700, size: 18, font })
  page.drawText('PUBLIC line three', { x: 50, y: 650, size: 18, font })
  return doc.save()
}

// A PDF whose secret lives ONLY inside a FreeText annotation (not in the content stream).
async function makeAnnotPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([400, 800])
  const font = await doc.embedFont(StandardFonts.Helvetica)
  page.drawText('PUBLIC body text', { x: 50, y: 750, size: 18, font })
  const annot = doc.context.obj({
    Type: PDFName.of('Annot'),
    Subtype: PDFName.of('FreeText'),
    Rect: [50, 690, 350, 720],
    Contents: PDFString.of('SECRETANNOT'),
    DA: PDFString.of('/Helv 12 Tf 0 g')
  })
  page.node.set(PDFName.of('Annots'), doc.context.obj([doc.context.register(annot)]))
  return doc.save()
}

const withDoc = <T>(bytes: Uint8Array, fn: (doc: number) => T): T => {
  const rt = pdfium.pdfium
  const ptr = rt.wasmExports.malloc(bytes.length)
  rt.HEAPU8.set(bytes, ptr)
  const doc = pdfium.FPDF_LoadMemDocument(ptr, bytes.length, '')
  try {
    return fn(doc)
  } finally {
    pdfium.FPDF_CloseDocument(doc)
    rt.wasmExports.free(ptr)
  }
}

const extractText = (bytes: Uint8Array): string =>
  withDoc(bytes, (doc) => {
    const rt = pdfium.pdfium
    const page = pdfium.FPDF_LoadPage(doc, 0)
    const tp = pdfium.FPDFText_LoadPage(page)
    const n = pdfium.FPDFText_CountChars(tp)
    const buf = rt.wasmExports.malloc((n + 1) * 2)
    pdfium.FPDFText_GetText(tp, 0, n, buf)
    const text = rt.UTF16ToString(buf)
    rt.wasmExports.free(buf)
    pdfium.FPDFText_ClosePage(tp)
    pdfium.FPDF_ClosePage(page)
    return text.replace(/\s+/g, ' ').trim()
  })

const annotCount = (bytes: Uint8Array): number =>
  withDoc(bytes, (doc) => {
    const page = pdfium.FPDF_LoadPage(doc, 0)
    const n = pdfium.FPDFPage_GetAnnotCount(page)
    pdfium.FPDF_ClosePage(page)
    return n
  })

// Render page 0 (400x800) on white and read the BGRA pixel at PDF point (px, py).
const pixelAt = (bytes: Uint8Array, px: number, py: number): [number, number, number] =>
  withDoc(bytes, (doc) => {
    const rt = pdfium.pdfium
    const W = 400
    const H = 800
    const page = pdfium.FPDF_LoadPage(doc, 0)
    const bmp = pdfium.FPDFBitmap_Create(W, H, 0)
    pdfium.FPDFBitmap_FillRect(bmp, 0, 0, W, H, 0xffffffff)
    pdfium.FPDF_RenderPageBitmap(bmp, page, 0, 0, W, H, 0, 0)
    const buf = pdfium.FPDFBitmap_GetBuffer(bmp)
    const stride = pdfium.FPDFBitmap_GetStride(bmp)
    const dx = Math.round(px)
    const dy = Math.round(H - py) // device origin is top-left
    const off = buf + dy * stride + dx * 4
    const rgb: [number, number, number] = [rt.HEAPU8[off + 2], rt.HEAPU8[off + 1], rt.HEAPU8[off]]
    pdfium.FPDFBitmap_Destroy(bmp)
    pdfium.FPDF_ClosePage(page)
    return rgb
  })

describe('redactPdf', () => {
  it('removes text under the box from the content while keeping the rest extractable', async () => {
    const bytes = await makeTextPdf()
    expect(extractText(bytes)).toContain('SECRET-9X42')

    const out = redactPdf(pdfium, bytes, [
      { pageIndex: 0, rects: [{ x: 40, y: 693, w: 320, h: 28 }] }
    ])
    const after = extractText(out)
    expect(after).not.toContain('SECRET') // genuinely removed from the content stream
    expect(after).toContain('PUBLIC line one') // surrounding text survives as real text
    expect(after).toContain('PUBLIC line three')
  })

  it('removes an annotation whose text would otherwise leak under the box', async () => {
    const bytes = await makeAnnotPdf()
    expect(annotCount(bytes)).toBe(1) // the FreeText annotation is present to start

    const out = redactPdf(pdfium, bytes, [
      { pageIndex: 0, rects: [{ x: 40, y: 685, w: 330, h: 40 }] } // covers the annotation rect
    ])
    expect(annotCount(out)).toBe(0) // the leaking annotation is gone, not merely covered
  })

  it('paints an opaque black box that actually renders over the redacted area', async () => {
    const bytes = await makeTextPdf()
    const rect = { x: 40, y: 693, w: 320, h: 28 }
    const out = redactPdf(pdfium, bytes, [{ pageIndex: 0, rects: [rect] }])
    const [r, g, b] = pixelAt(out, rect.x + rect.w / 2, rect.y + rect.h / 2)
    expect(r).toBeLessThan(30) // box center is black
    expect(g).toBeLessThan(30)
    expect(b).toBeLessThan(30)
  })

  it('leaves a page with no rects untouched', async () => {
    const bytes = await makeTextPdf()
    const out = redactPdf(pdfium, bytes, [{ pageIndex: 0, rects: [] }])
    expect(extractText(out)).toContain('SECRET-9X42')
  })
})
