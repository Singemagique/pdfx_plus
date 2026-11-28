import type { PDFDocumentProxy } from 'pdfjs-dist'

export interface PdfSource {
  id: string
  bytes: Uint8Array
  pdf: PDFDocumentProxy
  /**
   * `'image'` when PDFx made these bytes from an imported image (imageToPdf's Producer marker,
   * read at load): such a source skips OCR triage and is auto-recognised (DESIGN.md §3.4.1, D4).
   */
  origin?: 'image'
}

export interface PageEntry {
  id: string
  source: PdfSource
  pageIndex: number
  width: number
  height: number
}

export interface DocEntry {
  id: string
  name: string
  pages: PageEntry[]
}
