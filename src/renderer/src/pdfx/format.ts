import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { CropBox, Overlay } from '../edit/model'
import type { IntegrityRecord } from './canonicalize'

export { buildPdf, buildPdfx } from './build'

export const MANIFEST_NAME = 'pdfx-manifest.json'
export const PDFX_VERSION = '1.0'

export interface PdfxManifestDocument {
  name: string
  pages: number
}

/** PDFX v1.1 editable-edit record for one page, keyed by document + page index. */
export interface ManifestEdit {
  doc: number
  page: number
  rotation?: number
  /** Crop rectangle in PDF points (origin bottom-left); applied via /CropBox on export. */
  crop?: CropBox
  overlays?: Overlay[]
}

/** A base64-encoded image attachment referenced by image/signature overlays. */
export interface ManifestAttachment {
  mime: string
  data: string
}

/**
 * Provenance of the PDFx OCR text layer baked into one page (DESIGN.md §3.5.2, §3.7.6): which
 * engine, language data and pipeline produced it. PROVENANCE ONLY, never words: the words are the
 * layer itself, baked into the page content and so covered by `integrity`; this record, like the
 * rest of the manifest, is outside that hash.
 */
export interface ManifestOcrPage {
  /** Document index and page within it, as in `ManifestEdit`. */
  doc: number
  page: number
  engineId: string
  /**
   * Tesseract code → SHA-256 of its language data, the languages, and the pipeline version. All
   * three are absent for a layer kept from a source page whose own provenance was unknown (a
   * plain PDF export reopened): only its engine (from the layer's property list) is known then.
   */
  dataHashes?: Record<string, string>
  langs?: string[]
  pipelineVersion?: number
}

/** The manifest's `ocr` record (absent when no page carries a PDFx OCR layer). */
export interface ManifestOcr {
  v: 1
  pages: ManifestOcrPage[]
}

export interface PdfxManifest {
  pdfx: string
  title?: string
  documents: PdfxManifestDocument[]
  edits?: ManifestEdit[]
  attachments?: Record<string, ManifestAttachment>
  /** pdfx-canon/1 tamper record over the flattened page content (PRD §4.6). */
  integrity?: IntegrityRecord
  /**
   * OCR layer provenance (1.1.4). A new OPTIONAL key: `pdfx` is not raised for it, because a
   * reader that predates it (1.1.3's `readManifest`/`deserializeMirror`) ignores unknown keys.
   */
  ocr?: ManifestOcr
}

/** Bounds on the untrusted provenance JSON (`readOcrProvenance`). */
const MAX_PROVENANCE_STRING = 256
const MAX_PROVENANCE_LANGS = 32

const shortString = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= MAX_PROVENANCE_STRING

const pageIndex = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0

/**
 * The OCR provenance of `manifest` by GLOBAL page index (the page's index in the file, which is a
 * reopened source's `pageIndex`), validated: the manifest is untrusted JSON, so an entry that is
 * malformed, names a page the documents do not have, or repeats a page is skipped, and optional
 * fields that are malformed are dropped. Never throws.
 */
export function readOcrProvenance(manifest: PdfxManifest | null): Map<number, ManifestOcrPage> {
  const out = new Map<number, ManifestOcrPage>()
  const ocr = manifest?.ocr as unknown
  if (!ocr || typeof ocr !== 'object' || (ocr as { v?: unknown }).v !== 1) return out
  const pages = (ocr as { pages?: unknown }).pages
  if (!Array.isArray(pages) || !Array.isArray(manifest?.documents)) return out
  // The first global index of each document, as partitionPages lays them out.
  const counts = manifest.documents.map((d) =>
    Number.isInteger(d?.pages) && d.pages > 0 ? d.pages : 0
  )
  const starts: number[] = []
  let cursor = 0
  for (const n of counts) {
    starts.push(cursor)
    cursor += n
  }
  for (const raw of pages) {
    if (!raw || typeof raw !== 'object') continue
    const e = raw as Record<string, unknown>
    if (!pageIndex(e.doc) || !pageIndex(e.page) || !shortString(e.engineId)) continue
    if (e.doc >= counts.length || e.page >= counts[e.doc]) continue
    const index = starts[e.doc] + e.page
    if (out.has(index)) continue
    const entry: ManifestOcrPage = { doc: e.doc, page: e.page, engineId: e.engineId }
    const hashes = e.dataHashes
    if (hashes && typeof hashes === 'object' && !Array.isArray(hashes)) {
      const list = Object.entries(hashes as Record<string, unknown>)
      if (
        list.length <= MAX_PROVENANCE_LANGS &&
        list.every(([k, v]) => shortString(k) && shortString(v))
      )
        // prettier-ignore
        entry.dataHashes = Object.fromEntries(list) as Record<string, string>
    }
    if (
      Array.isArray(e.langs) &&
      e.langs.length <= MAX_PROVENANCE_LANGS &&
      e.langs.every(shortString)
    )
      // prettier-ignore
      entry.langs = [...e.langs]
    if (Number.isInteger(e.pipelineVersion) && (e.pipelineVersion as number) >= 0)
      entry.pipelineVersion = e.pipelineVersion as number
    out.set(index, entry)
  }
  return out
}

export interface PagePartition {
  name: string
  indices: number[]
}

export interface ExportPage {
  bytes: Uint8Array
  sourceKey: string
  pageIndex: number
}

export interface ExportDocument {
  name: string
  pages: ExportPage[]
}

function range(start: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => start + i)
}

export function stripExtension(filename: string): string {
  return filename.replace(/\.(pdf|pdfx)$/i, '')
}

export async function readManifest(pdf: PDFDocumentProxy): Promise<PdfxManifest | null> {
  const attachments = (await pdf.getAttachments()) as Record<
    string,
    { filename?: string; content: Uint8Array }
  > | null
  if (!attachments) return null

  for (const [key, attachment] of Object.entries(attachments)) {
    if ((attachment.filename ?? key) !== MANIFEST_NAME) continue
    try {
      const manifest = JSON.parse(new TextDecoder().decode(attachment.content)) as PdfxManifest
      const valid =
        manifest &&
        Array.isArray(manifest.documents) &&
        manifest.documents.every(
          (d) => typeof d.name === 'string' && Number.isInteger(d.pages) && d.pages > 0
        )
      return valid ? manifest : null
    } catch {
      return null
    }
  }
  return null
}

export function partitionPages(
  manifest: PdfxManifest | null,
  totalPages: number,
  fallbackName: string
): PagePartition[] {
  if (!manifest) return [{ name: fallbackName, indices: range(0, totalPages) }]

  const partitions: PagePartition[] = []
  let cursor = 0
  for (const entry of manifest.documents) {
    const count = Math.min(entry.pages, totalPages - cursor)
    if (count <= 0) break
    partitions.push({ name: entry.name, indices: range(cursor, count) })
    cursor += count
  }
  if (cursor < totalPages) {
    partitions.push({ name: 'Untitled', indices: range(cursor, totalPages - cursor) })
  }
  return partitions
}
