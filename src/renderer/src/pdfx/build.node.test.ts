import { describe, expect, it } from 'vitest'
import { unzlibSync } from 'fflate'
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFStream,
  PDFString
} from 'pdf-lib'

import { buildPdf, buildPdfx } from './build'
import { MANIFEST_NAME, partitionPages, stripExtension } from './format'
import type { ExportDocument, ExportPage, PdfxManifest } from './format'

// Build a tiny standalone single-page PDF we can use as an import source.
async function makeSourcePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.addPage([200, 200])
  return doc.save()
}

// Decode a stream's bytes, inflating if pdf-lib FlateDecode'd it (it may, when saving
// with object streams) and returning raw bytes otherwise — robust to the choice.
function streamBytes(stream: PDFStream): Uint8Array {
  const raw = (stream as PDFRawStream).getContents()
  const filter = stream.dict.lookup(PDFName.of('Filter'))
  return filter && String(filter).includes('FlateDecode') ? unzlibSync(raw) : raw
}

// Recover the embedded 'pdfx-manifest.json' bytes from saved PDFX bytes by walking the
// catalog's EmbeddedFiles name tree (Names -> EmbeddedFiles -> Names = [name, filespec, ...]).
// Typed lookups resolve indirect references; robust unlike a raw byte-substring search.
function extractEmbeddedFile(pdf: PDFDocument, wanted: string): Uint8Array | null {
  const names = pdf.catalog.lookupMaybe(PDFName.of('Names'), PDFDict)
  if (!names) return null
  const embeddedFiles = names.lookupMaybe(PDFName.of('EmbeddedFiles'), PDFDict)
  if (!embeddedFiles) return null
  const arr = embeddedFiles.lookupMaybe(PDFName.of('Names'), PDFArray)
  if (!arr) return null
  for (let i = 0; i < arr.size(); i += 2) {
    const key = arr.lookup(i)
    const name = key instanceof PDFString || key instanceof PDFHexString ? key.decodeText() : ''
    if (name !== wanted) continue
    const fileSpec = arr.lookup(i + 1, PDFDict)
    const ef = fileSpec.lookup(PDFName.of('EF'), PDFDict)
    const stream = ef.lookup(PDFName.of('F'), PDFStream)
    return streamBytes(stream)
  }
  return null
}

describe('buildPdfx', () => {
  it('concatenates pages and embeds a manifest describing document boundaries', async () => {
    const bytes = await makeSourcePdf()
    const documents: ExportDocument[] = [
      {
        name: 'NDA',
        pages: [
          { bytes, sourceKey: 'a', pageIndex: 0 },
          { bytes, sourceKey: 'a', pageIndex: 0 }
        ]
      },
      {
        name: 'Invoice',
        pages: [{ bytes, sourceKey: 'a', pageIndex: 0 }]
      }
    ]
    const expectedPages = documents.reduce((n, d) => n + d.pages.length, 0)

    const out = await buildPdfx(documents, 'Contract')
    const reloaded = await PDFDocument.load(out)

    // Page count equals the sum of every document's page count.
    expect(reloaded.getPageCount()).toBe(expectedPages)

    // The manifest is embedded under the exact required name.
    const manifestBytes = extractEmbeddedFile(reloaded, MANIFEST_NAME)
    expect(manifestBytes).not.toBeNull()

    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes!)) as PdfxManifest
    expect(manifest.pdfx).toBe('1.0')
    expect(manifest.title).toBe('Contract')
    expect(manifest.documents).toEqual([
      { name: 'NDA', pages: 2 },
      { name: 'Invoice', pages: 1 }
    ])
  })

  it('skips documents with no pages', async () => {
    const bytes = await makeSourcePdf()
    const documents: ExportDocument[] = [
      { name: 'Empty', pages: [] },
      { name: 'Real', pages: [{ bytes, sourceKey: 'a', pageIndex: 0 }] }
    ]
    const out = await buildPdfx(documents, 'X')
    const reloaded = await PDFDocument.load(out)
    expect(reloaded.getPageCount()).toBe(1)

    const manifest = JSON.parse(
      new TextDecoder().decode(extractEmbeddedFile(reloaded, MANIFEST_NAME)!)
    ) as PdfxManifest
    expect(manifest.documents).toEqual([{ name: 'Real', pages: 1 }])
  })
})

describe('buildPdf', () => {
  it('flattens pages into a plain PDF with no manifest attachment', async () => {
    const bytes = await makeSourcePdf()
    const pages: ExportPage[] = [
      { bytes, sourceKey: 'a', pageIndex: 0 },
      { bytes, sourceKey: 'a', pageIndex: 0 }
    ]
    const out = await buildPdf(pages)
    const reloaded = await PDFDocument.load(out)
    expect(reloaded.getPageCount()).toBe(2)
    expect(extractEmbeddedFile(reloaded, MANIFEST_NAME)).toBeNull()
  })
})

describe('format helpers', () => {
  it('stripExtension removes only .pdf/.pdfx (case-insensitive)', () => {
    expect(stripExtension('Contract.pdf')).toBe('Contract')
    expect(stripExtension('Contract.PDFX')).toBe('Contract')
    expect(stripExtension('photo.png')).toBe('photo.png')
    expect(stripExtension('archive.pdf.bak')).toBe('archive.pdf.bak')
  })

  it('partitionPages reproduces document boundaries from a manifest', () => {
    const manifest: PdfxManifest = {
      pdfx: '1.0',
      documents: [
        { name: 'NDA', pages: 2 },
        { name: 'Invoice', pages: 1 }
      ]
    }
    expect(partitionPages(manifest, 3, 'fallback')).toEqual([
      { name: 'NDA', indices: [0, 1] },
      { name: 'Invoice', indices: [2] }
    ])
  })

  it('partitionPages falls back to a single document when there is no manifest', () => {
    expect(partitionPages(null, 3, 'Whole')).toEqual([{ name: 'Whole', indices: [0, 1, 2] }])
  })

  it('partitionPages appends an Untitled tail when pages exceed the manifest', () => {
    const manifest: PdfxManifest = { pdfx: '1.0', documents: [{ name: 'A', pages: 1 }] }
    expect(partitionPages(manifest, 3, 'fallback')).toEqual([
      { name: 'A', indices: [0] },
      { name: 'Untitled', indices: [1, 2] }
    ])
  })
})
