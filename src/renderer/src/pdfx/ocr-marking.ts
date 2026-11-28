// Document-level marking of an export that carries a PDFx OCR layer (DESIGN.md §3.7.1, §3.7.7):
// the Producer suffix, `pdfx:OCREngine` in the XMP metadata, and the catalog /Lang (§3.7.5). The
// per-layer marking (the /PDFxOCR BDC property list with /MachineGenerated true) is written by
// ocr-layer.ts with the layer itself.

import {
  decodePDFRawStream,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString
} from 'pdf-lib'

import { OCR_PRODUCER_SUFFIX } from './ocr-export'

/**
 * The XMP namespace of the `pdfx:` prefix: Adobe's namespace for custom document properties (the
 * one Acrobat lists under Document Properties › Custom), so `pdfx:OCREngine` is readable as such.
 */
export const XMP_PDFX_NS = 'http://ns.adobe.com/pdfx/1.3/'
const XMP_PDF_NS = 'http://ns.adobe.com/pdf/1.3/'
const RDF_NS = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'

const xmlEscape = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** The catalog /Lang of `doc`, if it declares a non-empty one. */
export function readCatalogLang(doc: PDFDocument): string | undefined {
  const v = doc.catalog.lookup(PDFName.of('Lang'))
  if (!(v instanceof PDFString || v instanceof PDFHexString)) return undefined
  const s = v.decodeText().trim()
  return s || undefined
}

/** The document's XMP packet as text, if its catalog carries a /Metadata stream. */
export function readXmp(doc: PDFDocument): string | undefined {
  const stream = doc.catalog.lookupMaybe(PDFName.of('Metadata'), PDFStream)
  if (!stream) return undefined
  const bytes =
    stream instanceof PDFRawStream ? decodePDFRawStream(stream).decode() : stream.getContents()
  return new TextDecoder().decode(bytes)
}

/** A minimal XMP packet: pdf:Producer and pdfx:OCREngine. */
export function minimalXmp(producer: string, engine: string): string {
  return [
    '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>',
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
    ` <rdf:RDF xmlns:rdf="${RDF_NS}">`,
    `  <rdf:Description rdf:about="" xmlns:pdf="${XMP_PDF_NS}" xmlns:pdfx="${XMP_PDFX_NS}">`,
    `   <pdf:Producer>${xmlEscape(producer)}</pdf:Producer>`,
    `   <pdfx:OCREngine>${xmlEscape(engine)}</pdfx:OCREngine>`,
    '  </rdf:Description>',
    ' </rdf:RDF>',
    '</x:xmpmeta>',
    '<?xpacket end="w"?>'
  ].join('\n')
}

/**
 * Add `pdfx:OCREngine` to an existing XMP packet as its own rdf:Description, leaving everything
 * else as it was. Null when the packet has no `</rdf:RDF>` to insert before.
 */
export function addOcrEngineToXmp(xmp: string, engine: string): string | null {
  const end = xmp.lastIndexOf('</rdf:RDF>')
  if (end < 0) return null
  const description =
    `  <rdf:Description rdf:about="" xmlns:pdfx="${XMP_PDFX_NS}">\n` +
    `   <pdfx:OCREngine>${xmlEscape(engine)}</pdfx:OCREngine>\n` +
    '  </rdf:Description>\n '
  return xmp.slice(0, end) + description + xmp.slice(end)
}

/**
 * Mark `doc` as carrying a machine-generated text layer: Producer `${producer}` + the suffix, and
 * XMP `pdfx:OCREngine` = the engine ids (comma-separated when pages came from several). A minimal
 * XMP metadata stream is written when the document has none; an existing one is kept and only
 * gains the property (an unparseable one is left untouched).
 */
export function markOcrDocument(
  doc: PDFDocument,
  producer: string,
  engines: Iterable<string>
): void {
  const full = producer + OCR_PRODUCER_SUFFIX
  doc.setProducer(full)
  const engine = [...new Set(engines)].sort().join(', ')
  const existing = readXmp(doc)
  const xmp =
    existing === undefined ? minimalXmp(full, engine) : addOcrEngineToXmp(existing, engine)
  if (xmp === null) return
  const ctx = doc.context
  // Uncompressed, as XMP is meant to be found by tools that do not parse PDF.
  const stream = ctx.stream(new TextEncoder().encode(xmp), { Type: 'Metadata', Subtype: 'XML' })
  // Replace an existing packet in place, so the old one is not left behind as an orphan object.
  const entry = doc.catalog.get(PDFName.of('Metadata'))
  if (entry instanceof PDFRef) ctx.assign(entry, stream)
  else doc.catalog.set(PDFName.of('Metadata'), ctx.register(stream))
}
