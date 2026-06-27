import { describe, expect, it, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { init } from '@embedpdf/pdfium'
import type { PDFDocumentProxy } from 'pdfjs-dist'

import { applyRedactedBytes, buildRedactedSources } from './redact-export'
import { makePageKey, type Overlay } from '../edit/model'
import type { EditLayer } from './build'
import type { DocEntry, PageEntry } from '../types'
import type { PdfiumModule } from './redact'

type TestPdfium = PdfiumModule & {
  FPDFText_LoadPage(page: number): number
  FPDFText_CountChars(tp: number): number
  FPDFText_GetText(tp: number, start: number, count: number, buffer: number): number
  FPDFText_ClosePage(tp: number): void
  pdfium: PdfiumModule['pdfium'] & { UTF16ToString(ptr: number): string }
}

let pdfium: TestPdfium

beforeAll(async () => {
  const wasmBinary = readFileSync(
    fileURLToPath(
      new URL('../../../../node_modules/@embedpdf/pdfium/dist/pdfium.wasm', import.meta.url)
    )
  )
  const mod = await init({ wasmBinary })
  mod.PDFiumExt_Init()
  pdfium = mod as unknown as TestPdfium
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

function extractText(bytes: Uint8Array): string {
  const rt = pdfium.pdfium
  const ptr = rt.wasmExports.malloc(bytes.length)
  rt.HEAPU8.set(bytes, ptr)
  const doc = pdfium.FPDF_LoadMemDocument(ptr, bytes.length, '')
  const page = pdfium.FPDF_LoadPage(doc, 0)
  const tp = pdfium.FPDFText_LoadPage(page)
  const n = pdfium.FPDFText_CountChars(tp)
  const buf = rt.wasmExports.malloc((n + 1) * 2)
  pdfium.FPDFText_GetText(tp, 0, n, buf)
  const text = rt.UTF16ToString(buf)
  rt.wasmExports.free(buf)
  pdfium.FPDFText_ClosePage(tp)
  pdfium.FPDF_ClosePage(page)
  pdfium.FPDF_CloseDocument(doc)
  rt.wasmExports.free(ptr)
  return text.replace(/\s+/g, ' ').trim()
}

// A one-page DocEntry whose source proxy reports /Rotate 0 and a given view box (CropBox∩MediaBox
// in user space) — enough for the wiring under test.
function fakeDoc(bytes: Uint8Array, w: number, h: number, view: number[] = [0, 0, w, h]): DocEntry {
  const source = {
    id: 's1',
    bytes,
    pdf: { getPage: async () => ({ rotate: 0, view }) } as unknown as PDFDocumentProxy
  }
  const page: PageEntry = { id: 'p1', source, pageIndex: 0, width: w, height: h }
  return { id: 'd1', name: 'Doc', pages: [page] }
}

const redactionOverlay = (): Overlay => ({
  id: 'r1',
  pageKey: makePageKey('s1', 0),
  z: 0,
  createdAt: 0,
  geom: { x: 40, y: 693, w: 320, h: 28, rotation: 0, opacity: 1 },
  type: 'redaction',
  fill: { r: 0, g: 0, b: 0 }
})

describe('buildRedactedSources', () => {
  it('removes redacted content from the source bytes used on export', async () => {
    const bytes = await makeTextPdf()
    const editLayer: EditLayer = {
      overlays: new Map([[makePageKey('s1', 0), [redactionOverlay()]]]),
      attachments: new Map()
    }
    const redacted = await buildRedactedSources(editLayer, [fakeDoc(bytes, 400, 800)], pdfium)

    expect(redacted.has('s1')).toBe(true)
    const after = extractText(redacted.get('s1')!)
    expect(after).not.toContain('SECRET')
    expect(after).toContain('PUBLIC line one')
    expect(after).toContain('PUBLIC line three')

    // applyRedactedBytes swaps the redacted bytes in for that source.
    const swapped = applyRedactedBytes([{ sourceKey: 's1', bytes, pageIndex: 0 }], redacted)
    expect(swapped[0].bytes).toBe(redacted.get('s1'))
  })

  it('redacts the correct region on a page whose MediaBox origin is not (0,0)', async () => {
    // MediaBox [50,50,450,850]: text is in absolute user space; the editor box is view-relative.
    const doc = await PDFDocument.create()
    const page = doc.addPage()
    page.setMediaBox(50, 50, 400, 800)
    const font = await doc.embedFont(StandardFonts.Helvetica)
    page.drawText('PUBLIC up', { x: 100, y: 600, size: 18, font })
    page.drawText('SECRET-9X42', { x: 100, y: 400, size: 18, font })
    page.drawText('PUBLIC down', { x: 100, y: 200, size: 18, font })
    const bytes = await doc.save()

    // Box over SECRET in VIEW-relative coords (absolute y≈400 → view-relative y≈350).
    const redaction: Overlay = {
      ...redactionOverlay(),
      geom: { x: 20, y: 320, w: 360, h: 70, rotation: 0, opacity: 1 }
    }
    const editLayer: EditLayer = {
      overlays: new Map([[makePageKey('s1', 0), [redaction]]]),
      attachments: new Map()
    }
    const docs = [fakeDoc(bytes, 400, 800, [50, 50, 450, 850])]

    const redacted = await buildRedactedSources(editLayer, docs, pdfium)
    const after = extractText(redacted.get('s1')!)
    expect(after).not.toContain('SECRET') // origin offset applied → the right line is removed
    expect(after).toContain('PUBLIC up') // unaffected lines survive
    expect(after).toContain('PUBLIC down')
  })

  it('returns an empty map when there are no redaction overlays', async () => {
    const bytes = await makeTextPdf()
    const editLayer: EditLayer = { overlays: new Map(), attachments: new Map() }
    const redacted = await buildRedactedSources(editLayer, [fakeDoc(bytes, 400, 800)], pdfium)
    expect(redacted.size).toBe(0)
    // and applyRedactedBytes is a no-op
    const pages = [{ sourceKey: 's1', bytes, pageIndex: 0 }]
    expect(applyRedactedBytes(pages, redacted)).toBe(pages)
  })
})
