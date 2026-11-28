// OCR layer provenance in the .pdfx manifest (DESIGN.md §3.5.2, §3.7.6): which engine, language
// data and pipeline produced the PDFx OCR layer baked into each page. Provenance only, never
// words: the words are the layer itself, baked into the page content before computeIntegrity, so
// the pdfx-canon/1 record covers the layer's content stream (its tokens: the glyph codes and their
// placement). It does NOT cover what those codes read as: the text Find and copy return comes from
// the OCR font's ToUnicode CMap, a font resource, and pdfx-canon/1 hashes no font (canonicalize.ts,
// Scope), so the recognised words can be rewritten without tripping the tamper gate. Making them
// tamper-evident needs the decoded ToUnicode of the PDFx OCR fonts in a future canon version; a
// hash in this record would not help, since the manifest is outside the hash. The record types and
// the validating reader live in
// format.ts (`ManifestOcr`, `readOcrProvenance`); this module builds entries for build.ts and
// reads a SOURCE .pdfx's manifest through pdf-lib, so a layer kept on re-export keeps its record.

import {
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFStream,
  PDFString,
  type PDFDocument
} from 'pdf-lib'

import type { PackedOcrPage } from '../../../shared/ocr/types'
import { CANON_ALG, integrityOf, type IntegrityRecord } from './canonicalize'
import { MANIFEST_NAME, readOcrProvenance, type ManifestOcrPage, type PdfxManifest } from './format'

/** What an output page's layer is recorded as, before its (doc, page) position is known. */
export type OcrProvenance = Omit<ManifestOcrPage, 'doc' | 'page'>

/** The provenance of a layer baked now from `page`: its metadata, none of its words. */
export function provenanceOf(page: PackedOcrPage): OcrProvenance {
  return {
    engineId: page.engineId,
    dataHashes: { ...page.dataHashes },
    langs: [...page.langs],
    pipelineVersion: page.pipelineVersion
  }
}

/** The (doc, page) record of `p` for output page `ordinal`, given the documents' page counts. */
export function placeProvenance(
  p: OcrProvenance,
  ordinal: number,
  docPages: readonly number[]
): ManifestOcrPage | null {
  let rest = ordinal
  for (let doc = 0; doc < docPages.length; doc++) {
    if (rest < docPages[doc]) return { doc, page: rest, ...p }
    rest -= docPages[doc]
  }
  return null
}

/** Bound on the embedded-files name tree walk (a crafted tree can be deep or cyclic). */
const MAX_NAME_TREE_NODES = 256

/**
 * The PDFx manifest embedded in `doc` (a source loaded with pdf-lib), or null when there is none or
 * it cannot be read. Its content is untrusted JSON: callers only take what `readOcrProvenance`
 * validates.
 */
export function embeddedManifest(doc: PDFDocument): PdfxManifest | null {
  try {
    const names = doc.catalog.lookupMaybe(PDFName.of('Names'), PDFDict)
    const root = names?.lookupMaybe(PDFName.of('EmbeddedFiles'), PDFDict)
    if (!root) return null
    const queue: PDFDict[] = [root]
    const seen = new Set<PDFDict>()
    while (queue.length && seen.size < MAX_NAME_TREE_NODES) {
      const node = queue.shift()!
      if (seen.has(node)) continue
      seen.add(node)
      const kids = node.lookupMaybe(PDFName.of('Kids'), PDFArray)
      for (let i = 0; i < (kids?.size() ?? 0); i++) {
        const kid = kids!.lookup(i)
        if (kid instanceof PDFDict) queue.push(kid)
      }
      const arr = node.lookupMaybe(PDFName.of('Names'), PDFArray)
      for (let i = 0; arr && i + 1 < arr.size(); i += 2) {
        const key = arr.lookup(i)
        if (!(key instanceof PDFString || key instanceof PDFHexString)) continue
        if (key.decodeText() !== MANIFEST_NAME) continue
        const spec = arr.lookup(i + 1)
        const ef = spec instanceof PDFDict ? spec.lookupMaybe(PDFName.of('EF'), PDFDict) : undefined
        const file = ef?.lookup(PDFName.of('F'))
        if (!(file instanceof PDFStream)) return null
        const bytes = file instanceof PDFRawStream ? decodePDFRawStream(file).decode() : file.getContents() // prettier-ignore
        const json = JSON.parse(new TextDecoder().decode(bytes)) as unknown
        return json && typeof json === 'object' ? (json as PdfxManifest) : null
      }
    }
  } catch {
    return null
  }
  return null
}

/**
 * The provenance a SOURCE document records for its pages, by page index: what a layer kept from
 * that source on re-export is recorded as (validated, see `readOcrProvenance`). Empty for a source
 * that is not a .pdfx or records none.
 *
 * The manifest is outside the pdfx-canon/1 hash, so another tool can move, swap or rewrite pages
 * and keep it: a record is only returned while the page still is the one it was written for. When
 * the source carries a pdfx-canon/1 record, the page's hash is recomputed over `bytes` (the source
 * as the export reads it) and a page whose hash differs from the recorded one loses its record (a
 * hash that cannot be recomputed drops them all). Without such a record nothing can be proved, as
 * on open (`compareIntegrity`); build.ts then still checks each record's engine against the one the
 * layer's own property list names.
 */
export async function sourceProvenance(
  doc: PDFDocument,
  bytes: Uint8Array
): Promise<Map<number, OcrProvenance>> {
  const out = new Map<number, OcrProvenance>()
  const manifest = embeddedManifest(doc)
  const records = readOcrProvenance(manifest)
  if (!records.size) return out
  const integrity = manifest?.integrity as Partial<IntegrityRecord> | undefined
  let hashes: readonly string[] | null = null
  if (integrity?.canonAlg === CANON_ALG) {
    try {
      hashes = (await integrityOf(bytes)).pageHashes
    } catch {
      return out
    }
  }
  const recorded: unknown[] = Array.isArray(integrity?.pageHashes) ? integrity.pageHashes : []
  for (const [index, { doc: _d, page: _p, ...p }] of records) {
    if (hashes && hashes[index] !== recorded[index]) continue
    out.set(index, p)
  }
  return out
}
