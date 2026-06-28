import {
  PDFDocument,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFPage,
  PDFRef,
  PDFString,
  concatTransformationMatrix,
  degrees,
  popGraphicsState,
  pushGraphicsState
} from 'pdf-lib'

import { MANIFEST_NAME, PDFX_VERSION } from './format'
import type { ExportDocument, ExportPage, PdfxManifest } from './format'
import { makePageKey } from '../edit/model'
import type { CropBox, Overlay } from '../edit/model'
import {
  createFlattenResources,
  flattenPageOverlays,
  type Attachment,
  type FlattenResources
} from './flatten'
import { serializeMirror } from './mirror'
import { computeIntegrity } from './canonicalize'

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
  /** Per-page crop rectangle (PDF points, bottom-left), keyed by page key. Applied via /CropBox. */
  crops?: Map<string, CropBox>
}

interface Box {
  x: number
  y: number
  width: number
  height: number
}

/**
 * The page's visible view box = CropBox ∩ MediaBox, matching how pdf.js derives the dimensions
 * the editor captured overlay/crop coordinates against (PDFPageProxy.view). pdf-lib's getCropBox()
 * returns the raw /CropBox, which a PDF may legally extend past the /MediaBox; intersecting keeps
 * the export math in the same coordinate space for every valid box configuration. Degenerate
 * intersections fall back to the MediaBox, as pdf.js does.
 */
function viewBox(crop: Box, media: Box): Box {
  const x0 = Math.max(crop.x, media.x)
  const y0 = Math.max(crop.y, media.y)
  const x1 = Math.min(crop.x + crop.width, media.x + media.width)
  const y1 = Math.min(crop.y + crop.height, media.y + media.height)
  if (x1 > x0 && y1 > y0) return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
  return { x: media.x, y: media.y, width: media.width, height: media.height }
}

/**
 * Map a crop captured in the editor's page space back into the unrotated user space that
 * setCropBox() expects. pdf.js bakes a source page's intrinsic /Rotate into the page
 * dimensions the editor draws against, but pdf-lib's CropBox is always unrotated — so for a
 * source /Rotate of 90/270 the axes (and box dimensions W,H) are swapped and must be undone.
 * Editor-applied rotation is NOT undone here: it is removed from the stored crop at capture
 * time and re-applied as extra /Rotate, so only the source's intrinsic angle matters.
 */
export function unrotateCrop(c: CropBox, intrinsic: number, W: number, H: number): CropBox {
  switch (intrinsic) {
    case 90:
      return { x: W - c.y - c.h, y: c.x, w: c.h, h: c.w }
    case 180:
      return { x: W - c.x - c.w, y: H - c.y - c.h, w: c.w, h: c.h }
    case 270:
      return { x: c.y, y: H - c.x - c.w, w: c.h, h: c.w }
    default:
      return { x: c.x, y: c.y, w: c.w, h: c.h }
  }
}

/**
 * Content-stream matrix (the `cm` operator's a,b,c,d,e,f) that maps the editor's page space —
 * where pdf.js has baked the source page's intrinsic /Rotate into the page dimensions — into
 * the page's unrotated user space. Overlays are stored in that visual space; drawing them
 * through this matrix (inside a q…Q) places them at unrotated coordinates so the page's /Rotate
 * then displays them exactly where the user put them. Returns null for an unrotated page (no-op).
 * (W, H) are the unrotated view-box dimensions. Mirrors the rect logic in unrotateCrop.
 */
function intrinsicMatrix(
  intrinsic: number,
  W: number,
  H: number
): [number, number, number, number, number, number] | null {
  switch (intrinsic) {
    case 90:
      return [0, 1, -1, 0, W, 0]
    case 180:
      return [-1, 0, 0, -1, W, H]
    case 270:
      return [0, -1, 1, 0, 0, H]
    default:
      return null
  }
}

/** Fully-qualified AcroForm field name of a widget annotation (walks the /Parent chain). */
function widgetFieldName(ctx: PDFDocument['context'], dict: PDFDict): string | undefined {
  const parts: string[] = []
  let d: PDFDict | undefined = dict
  for (let guard = 0; d && guard < 32; guard++) {
    const t = d.get(PDFName.of('T'))
    if (t instanceof PDFString || t instanceof PDFHexString) parts.unshift(t.decodeText())
    const parent = d.get(PDFName.of('Parent'))
    d =
      parent instanceof PDFRef
        ? ctx.lookupMaybe(parent, PDFDict)
        : parent instanceof PDFDict
          ? parent
          : undefined
  }
  return parts.length ? parts.join('.') : undefined
}

/**
 * Remove the interactive widget annotations of fields we've FILLED (painted) so the original
 * widget appearance (its old value) doesn't double with the flattened value — and a cleared field
 * doesn't keep showing its old value. Untouched fields keep their widgets (and pre-filled values).
 */
function removeFilledWidgets(page: PDFPage, filled: Set<string>): void {
  const annots = page.node.Annots()
  if (!annots) return
  const ctx = page.doc.context
  const keep: Array<ReturnType<typeof annots.get>> = []
  for (let i = 0; i < annots.size(); i++) {
    const ref = annots.get(i)
    const dict = ref instanceof PDFRef ? ctx.lookupMaybe(ref, PDFDict) : ref instanceof PDFDict ? ref : undefined // prettier-ignore
    const isWidget = !!dict && dict.get(PDFName.of('Subtype')) === PDFName.of('Widget')
    if (isWidget) {
      const name = widgetFieldName(ctx, dict)
      if (name && filled.has(name)) continue // drop this widget
    }
    keep.push(ref)
  }
  page.node.set(PDFName.of('Annots'), ctx.obj(keep))
}

async function bakePage(
  page: PDFPage,
  exportPage: ExportPage,
  edits: EditLayer | undefined,
  res: FlattenResources | undefined
): Promise<void> {
  if (!edits) return
  const key = makePageKey(exportPage.sourceKey, exportPage.pageIndex)
  // The source page's intrinsic /Rotate and its original (pre-crop) unrotated view box. Both are
  // captured up front because the editor's overlay/crop coordinates live in pdf.js's
  // rotation-baked "visual" space, which we reconcile with pdf-lib's unrotated space below.
  const intrinsic = (((page.getRotation().angle % 360) + 360) % 360) as number
  const view0 = viewBox(page.getCropBox(), page.getMediaBox())
  const rot = edits.rotations?.get(key)
  if (rot) {
    page.setRotation(degrees((((intrinsic + rot) % 360) + 360) % 360))
  }
  const crop = edits.crops?.get(key)
  if (crop && crop.w > 0 && crop.h > 0) {
    // Map the crop into unrotated user space, then offset by the view-box origin so pages whose
    // box does not start at (0,0) crop correctly.
    const u = unrotateCrop(crop, intrinsic, view0.width, view0.height)
    page.setCropBox(view0.x + u.x, view0.y + u.y, u.w, u.h)
  }
  const list = edits.overlays.get(key)
  if (res && list && list.length > 0) {
    const sorted = [...list].sort((a, b) => a.z - b.z || a.createdAt - b.createdAt)
    // On a source page with intrinsic /Rotate, draw overlays through a transform that converts
    // their visual-space coordinates to unrotated space; the page's /Rotate then shows them where
    // the user placed them. This handles every overlay type (text angle, images, ink, shapes).
    const m = intrinsicMatrix(intrinsic, view0.width, view0.height)
    if (m) page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...m))
    await flattenPageOverlays(page, sorted, res)
    if (m) page.pushOperators(popGraphicsState())
  }
  // Form fill paints the value as page content; drop the matching interactive widget so its own
  // appearance (the original value) doesn't render on top of — and double with — the painted one.
  if (list) {
    const filled = new Set(
      list
        .filter((o) => o.type === 'formValue')
        .map((o) => (o as Extract<Overlay, { type: 'formValue' }>).field)
    )
    if (filled.size) removeFilledWidgets(page, filled)
  }
}

export async function buildPdf(pages: ExportPage[], edits?: EditLayer): Promise<Uint8Array> {
  const output = await PDFDocument.create()
  const res = edits ? createFlattenResources(output, edits.attachments) : undefined
  const sources = new Map<string, PDFDocument>()
  let ordinal = 0
  for (const page of pages) {
    ordinal++
    // Tag any failure with which page failed, so a single bad source (e.g. one odd scan) is
    // identifiable instead of surfacing as a bare "Export failed".
    try {
      let source = sources.get(page.sourceKey)
      if (!source) {
        source = await PDFDocument.load(page.bytes, { ignoreEncryption: true })
        sources.set(page.sourceKey, source)
      }
      const [copied] = await output.copyPages(source, [page.pageIndex])
      output.addPage(copied)
      await bakePage(copied, page, edits, res)
    } catch (e) {
      throw new Error(
        `Export failed on page ${ordinal} (source page ${page.pageIndex + 1}): ${e instanceof Error ? e.message : String(e)}`
      )
    }
  }
  output.setProducer(`PDFX ${PDFX_VERSION}`)
  try {
    return await output.save()
  } catch (e) {
    throw new Error(
      `Export failed while writing the combined PDF: ${e instanceof Error ? e.message : String(e)}`
    )
  }
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

  // pdfx-canon/1 tamper record over the assembled page content, computed BEFORE the manifest is
  // attached so the manifest itself is excluded from the hash (PRD §4.6).
  manifest.integrity = await computeIntegrity(output)

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
