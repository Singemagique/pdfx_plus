// Shared PDFium fixtures for the renderer's node tests (redact / redact-export). Test-only:
// it lives inside src/renderer/src so tsconfig.web.json type-checks it, and is excluded from
// coverage.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { init } from '@embedpdf/pdfium'

import type { PdfiumModule } from '../pdfx/redact'

/**
 * The engine only needs the calls in PdfiumModule; the tests additionally extract text to PROVE
 * removal, so they use this wider runtime view.
 */
export interface TextPdfium extends PdfiumModule {
  FPDFText_LoadPage(page: number): number
  FPDFText_CountChars(textPage: number): number
  FPDFText_GetText(textPage: number, start: number, count: number, buffer: number): number
  FPDFText_ClosePage(textPage: number): void
  pdfium: PdfiumModule['pdfium'] & { UTF16ToString(ptr: number): string }
}

/** Boot the PDFium WASM from node_modules (no network, no bundler) and initialise it. */
export async function loadTestPdfium<T extends TextPdfium = TextPdfium>(): Promise<T> {
  const wasmBinary = readFileSync(
    fileURLToPath(
      new URL('../../../../node_modules/@embedpdf/pdfium/dist/pdfium.wasm', import.meta.url)
    )
  )
  const mod = await init({ wasmBinary })
  mod.PDFiumExt_Init()
  return mod as unknown as T
}

/** Load `bytes` as a PDFium document, run `fn`, and always release the document and its buffer. */
export function withDoc<T>(pdfium: PdfiumModule, bytes: Uint8Array, fn: (doc: number) => T): T {
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

/** The whitespace-normalised text PDFium extracts from page 0. */
export function extractText(pdfium: TextPdfium, bytes: Uint8Array): string {
  return withDoc(pdfium, bytes, (doc) => {
    const rt = pdfium.pdfium
    const page = pdfium.FPDF_LoadPage(doc, 0)
    const tp = pdfium.FPDFText_LoadPage(page)
    const n = pdfium.FPDFText_CountChars(tp)
    const buf = rt.wasmExports.malloc((n + 1) * 2)
    try {
      pdfium.FPDFText_GetText(tp, 0, n, buf)
      return rt.UTF16ToString(buf).replace(/\s+/g, ' ').trim()
    } finally {
      rt.wasmExports.free(buf)
      pdfium.FPDFText_ClosePage(tp)
      pdfium.FPDF_ClosePage(page)
    }
  })
}

/** A 400x800 page with one secret line between two public ones. */
export async function makeTextPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([400, 800])
  const font = await doc.embedFont(StandardFonts.Helvetica)
  page.drawText('PUBLIC line one', { x: 50, y: 750, size: 18, font })
  page.drawText('SECRET-9X42 confidential', { x: 50, y: 700, size: 18, font })
  page.drawText('PUBLIC line three', { x: 50, y: 650, size: 18, font })
  return doc.save()
}
