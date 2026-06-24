import { PDFDocument } from 'pdf-lib'

import { MANIFEST_NAME, PDFX_VERSION } from './format'
import type { ExportDocument, ExportPage, PdfxManifest } from './format'

export async function buildPdf(pages: ExportPage[]): Promise<Uint8Array> {
  const output = await PDFDocument.create()
  const sources = new Map<string, PDFDocument>()
  for (const page of pages) {
    let source = sources.get(page.sourceKey)
    if (!source) {
      source = await PDFDocument.load(page.bytes, { ignoreEncryption: true })
      sources.set(page.sourceKey, source)
    }
    const [copied] = await output.copyPages(source, [page.pageIndex])
    output.addPage(copied)
  }
  output.setProducer(`PDFX ${PDFX_VERSION}`)
  return output.save()
}

export async function buildPdfx(documents: ExportDocument[], title: string): Promise<Uint8Array> {
  const output = await PDFDocument.create()
  const manifest: PdfxManifest = { pdfx: PDFX_VERSION, title, documents: [] }
  const sources = new Map<string, PDFDocument>()

  for (const doc of documents) {
    if (doc.pages.length === 0) continue
    for (const page of doc.pages) {
      let source = sources.get(page.sourceKey)
      if (!source) {
        source = await PDFDocument.load(page.bytes, { ignoreEncryption: true })
        sources.set(page.sourceKey, source)
      }
      const [copied] = await output.copyPages(source, [page.pageIndex])
      output.addPage(copied)
    }
    manifest.documents.push({ name: doc.name, pages: doc.pages.length })
  }

  await output.attach(new TextEncoder().encode(JSON.stringify(manifest, null, 2)), MANIFEST_NAME, {
    mimeType: 'application/json',
    description: 'PDFX manifest describing the documents in this collection',
    creationDate: new Date(),
    modificationDate: new Date()
  })

  output.setTitle(title)
  output.setProducer(`PDFX ${PDFX_VERSION}`)
  output.setKeywords(['PDFX'])

  return output.save()
}
