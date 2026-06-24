import type { PDFDocumentProxy } from 'pdfjs-dist'

export interface PdfSource {
  id: string
  bytes: Uint8Array
  pdf: PDFDocumentProxy
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
