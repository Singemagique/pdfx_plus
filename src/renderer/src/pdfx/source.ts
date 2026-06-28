import { getDocument } from 'pdfjs-dist'
import { partitionPages, readManifest, stripExtension } from './format'
import { findConverter } from './convert'
import { deserializeMirror, type ImportedMirror } from './mirror'
import { CANON_ALG, integrityOf } from './canonicalize'
import type { DocEntry, PageEntry, PdfSource } from '../types'

interface PageSize {
  width: number
  height: number
}

export interface LoadedSource {
  source: PdfSource
  sizes: PageSize[]
}

export interface ExportPageRef {
  sourceKey: string
  bytes: Uint8Array
  pageIndex: number
}

// A crafted PDF can advertise an enormous page count (or a shared/cyclic page tree)
// to exhaust renderer memory; refuse to materialize an absurd number of pages.
const MAX_PAGES = 10_000

export async function loadSource(bytes: Uint8Array): Promise<LoadedSource> {
  const pdf = await getDocument({ data: bytes.slice() }).promise
  if (pdf.numPages > MAX_PAGES) {
    throw new Error(`PDF declares ${pdf.numPages} pages; refusing to load more than ${MAX_PAGES}`)
  }
  const source: PdfSource = { id: crypto.randomUUID(), bytes, pdf }
  const sizes: PageSize[] = []
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i)
    const viewport = page.getViewport({ scale: 1 })
    sizes.push({ width: viewport.width, height: viewport.height })
  }
  return { source, sizes }
}

export function pagesFromSource(
  source: PdfSource,
  sizes: PageSize[],
  indices: number[]
): PageEntry[] {
  return indices.map((pageIndex) => ({
    id: crypto.randomUUID(),
    source,
    pageIndex,
    width: sizes[pageIndex].width,
    height: sizes[pageIndex].height
  }))
}

export interface ImportResult {
  docs: DocEntry[]
  mirror: ImportedMirror | null
  /** Advisory message if the pdfx-canon/1 tamper check failed (the content was edited externally). */
  integrityWarning?: string
}

/** Recompute pdfx-canon/1 over the bytes and compare to the manifest record (advisory; PRD §4.6). */
async function checkIntegrity(
  bytes: Uint8Array,
  record?: { canonAlg: string; flattenedSha256: string; pageHashes: string[] }
): Promise<string | undefined> {
  if (record?.canonAlg !== CANON_ALG) return undefined // unknown alg → never enforced (advisory)
  try {
    const actual = await integrityOf(bytes)
    if (actual.flattenedSha256 === record.flattenedSha256) return undefined
    const changed = actual.pageHashes
      .map((h, i) => (h !== record.pageHashes[i] ? i + 1 : 0))
      .filter((n) => n > 0)
    return changed.length
      ? `Edited externally — page${changed.length > 1 ? 's' : ''} ${changed.join(', ')} changed since these edits were saved; they may be stale.`
      : 'This .pdfx failed its integrity check; the edits may be stale.'
  } catch {
    return undefined // recompute failed → stay silent (advisory)
  }
}

export async function importIntoDocs(filename: string, bytes: Uint8Array): Promise<ImportResult> {
  const { source, sizes } = await loadSource(bytes)
  const manifest = await readManifest(source.pdf)
  const docs = partitionPages(manifest, source.pdf.numPages, stripExtension(filename)).map(
    (part) => ({
      id: crypto.randomUUID(),
      name: part.name,
      pages: pagesFromSource(source, sizes, part.indices)
    })
  )
  return {
    docs,
    mirror: manifest ? deserializeMirror(manifest, docs) : null,
    integrityWarning: await checkIntegrity(bytes, manifest?.integrity)
  }
}

export const toExportPage = (page: PageEntry): ExportPageRef => ({
  sourceKey: page.source.id,
  bytes: page.source.bytes,
  pageIndex: page.pageIndex
})

export async function loadIncomingPages(
  files: { name: string; data: Uint8Array; path?: string }[],
  reference?: PageSize
): Promise<PageEntry[]> {
  const entries: PageEntry[] = []
  for (const file of files) {
    const conv = findConverter(file.name, file.data)
    const bytes = conv ? await conv.toPdf(file.name, file.data, reference, file.path) : file.data
    const { source, sizes } = await loadSource(bytes)
    entries.push(
      ...pagesFromSource(
        source,
        sizes,
        sizes.map((_, i) => i)
      )
    )
  }
  return entries
}
