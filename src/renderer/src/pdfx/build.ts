import { PDFDocument, PDFPage, degrees } from 'pdf-lib'

import { MANIFEST_NAME, PDFX_VERSION } from './format'
import type { ExportDocument, ExportPage, PdfxManifest } from './format'
import { makePageKey } from '../edit/model'
import type { Overlay } from '../edit/model'
import {
  createFlattenResources,
  flattenPageOverlays,
  type Attachment,
  type FlattenResources
} from './flatten'
import { serializeMirror } from './mirror'

/**
 * The optional edit layer baked into pages on export (PRD §4.4). Overlays are keyed by
 * page key — makePageKey(sourceKey, pageIndex) — and image overlays reference `attachments`
 * by id. When omitted, export behaves exactly as before (no overlays). The PDFX v1.1
 * editable-mirror embedding is added separately (roadmap Phase 2); this only flattens.
 */
export interface EditLayer {
  overlays: Map<string, Overlay[]>
  attachments: Map<string, Attachment>
  /** Per-page extra rotation in degrees CW, keyed by page key. Applied via /Rotate. */
  rotations?: Map<string, number>
}

async function bakePage(
  page: PDFPage,
  exportPage: ExportPage,
  edits: EditLayer | undefined,
  res: FlattenResources | undefined
): Promise<void> {
  if (!edits) return
  const key = makePageKey(exportPage.sourceKey, exportPage.pageIndex)
  const rot = edits.rotations?.get(key)
  if (rot) {
    page.setRotation(degrees((((page.getRotation().angle + rot) % 360) + 360) % 360))
  }
  const list = edits.overlays.get(key)
  if (res && list && list.length > 0) {
    const sorted = [...list].sort((a, b) => a.z - b.z || a.createdAt - b.createdAt)
    await flattenPageOverlays(page, sorted, res)
  }
}

export async function buildPdf(pages: ExportPage[], edits?: EditLayer): Promise<Uint8Array> {
  const output = await PDFDocument.create()
  const res = edits ? createFlattenResources(output, edits.attachments) : undefined
  const sources = new Map<string, PDFDocument>()
  for (const page of pages) {
    let source = sources.get(page.sourceKey)
    if (!source) {
      source = await PDFDocument.load(page.bytes, { ignoreEncryption: true })
      sources.set(page.sourceKey, source)
    }
    const [copied] = await output.copyPages(source, [page.pageIndex])
    output.addPage(copied)
    await bakePage(copied, page, edits, res)
  }
  output.setProducer(`PDFX ${PDFX_VERSION}`)
  return output.save()
}

export async function buildPdfx(
  documents: ExportDocument[],
  title: string,
  edits?: EditLayer
): Promise<Uint8Array> {
  const output = await PDFDocument.create()
  const manifest: PdfxManifest = { pdfx: PDFX_VERSION, title, documents: [] }
  const sources = new Map<string, PDFDocument>()

  // .pdfx keeps pages CLEAN — overlays/rotation are stored in the manifest mirror instead of
  // baked in, so the file reopens fully editable. Export PDF produces the flattened, shareable
  // copy (any viewer sees the annotations there).
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

  if (edits) {
    const mirror = serializeMirror(documents, edits)
    if (mirror) {
      manifest.pdfx = '1.1'
      manifest.edits = mirror.edits
      manifest.attachments = mirror.attachments
    }
  }

  await output.attach(new TextEncoder().encode(JSON.stringify(manifest, null, 2)), MANIFEST_NAME, {
    mimeType: 'application/json',
    description: 'PDFX manifest describing the documents in this collection',
    creationDate: new Date(),
    modificationDate: new Date()
  })

  output.setTitle(title)
  output.setProducer(`PDFX ${manifest.pdfx}`)
  output.setKeywords(['PDFX'])

  return output.save()
}
