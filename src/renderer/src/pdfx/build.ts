import {
  PDFArray,
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
import { serializeMirror, stripRedactedOverlays } from './mirror'
import { computeIntegrity } from './canonicalize'
import type { PackedOcrPage } from '../../../shared/ocr/types'
import { visibleBox } from '../page-geometry'
import { OcrFontCache } from './ocr-font'
import { appendOcrLayer, type OcrPageSpace } from './ocr-layer'
import { catalogLang, dropWordsOutside, ocrAllowed } from './ocr-export'
import { markOcrDocument, readCatalogLang } from './ocr-marking'

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
  /**
   * Recognised text per page key, baked as the invisible OCR text layer (DESIGN.md §3.7). Never set
   * on EditProvider's layer: useExport adds it to a copy (`withOcrLayer`, ocr-export.ts).
   */
  ocr?: Map<string, PackedOcrPage>
}

/**
 * The OCR layer state of ONE output document: its font (finalised once, after the last page and
 * before computeIntegrity/save) and, per output page, what was baked there (for the marking and
 * the catalog /Lang rule).
 */
interface OcrBake {
  fonts: OcrFontCache
  /** Engine ids of the layers written. */
  engines: Set<string>
  /** By output page ordinal: the primary Tesseract language of its layer (unset if none). */
  langs: (string | undefined)[]
}

const newOcrBake = (doc: PDFDocument, edits: EditLayer | undefined): OcrBake | undefined =>
  edits?.ocr?.size ? { fonts: new OcrFontCache(doc), engines: new Set(), langs: [] } : undefined

/**
 * The recognised page to bake for `key`, or undefined. Re-checks the export gate (ocr-export.ts
 * `ocrAllowed`) so a layer handed over without `withOcrLayer` still never puts text on a page
 * that has a redaction.
 */
function ocrPageFor(edits: EditLayer | undefined, key: string): PackedOcrPage | undefined {
  const page = edits?.ocr?.get(key)
  return page && edits && ocrAllowed(edits, key) ? page : undefined
}

/**
 * Prepend `ocr` to `page` as its own tagged content stream (ocr-layer.ts `appendOcrLayer`) in the
 * page space `space`, and record it in `bake`. Returns whether a layer was written.
 */
function bakeOcrLayer(
  page: PDFPage,
  ocr: PackedOcrPage,
  bake: OcrBake,
  ordinal: number,
  space: OcrPageSpace
): boolean {
  if (!appendOcrLayer(page, ocr, bake.fonts, { space })) return false
  bake.engines.add(ocr.engineId)
  bake.langs[ordinal] = ocr.langs[0]
  return true
}

/**
 * Finish the OCR layer of `output`: write the font tables from the CIDs actually baked (redaction
 * rule 5), then the machine-generated marking when any layer was written, and the catalog /Lang
 * (§3.7.5) from the sources' own /Lang and the baked layers. Runs after the last page is baked and
 * before computeIntegrity/save; the Producer is set here, so callers must not overwrite it later.
 */
function finishOcr(
  output: PDFDocument,
  bake: OcrBake | undefined,
  pageCount: number,
  sources: Iterable<PDFDocument>,
  producer: string
): void {
  bake?.fonts.finalize(output)
  if (bake?.engines.size) markOcrDocument(output, producer, bake.engines)
  else output.setProducer(producer)
  const langs = bake?.langs ?? []
  const lang = catalogLang(
    [...sources].map(readCatalogLang),
    Array.from({ length: pageCount }, (_, i) => langs[i])
  )
  if (lang) output.setLanguage(lang)
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
export function viewBox(crop: Box, media: Box): Box {
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
export function intrinsicMatrix(
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

/**
 * The overlay frame → user space pair of a page: the view-box origin translation and, for a source
 * /Rotate of 90/180/270, `intrinsicMatrix`. Overlays and the OCR layer both go through it.
 */
export function pageSpace(intrinsic: number, view0: Box): OcrPageSpace {
  return {
    view: { x: view0.x, y: view0.y },
    intrinsic: intrinsicMatrix(intrinsic, view0.width, view0.height)
  }
}

/**
 * Draw in a page's overlay frame. Overlay coordinates are captured in the editor's VIEW-relative
 * space (0-based over the view box, the source's intrinsic /Rotate baked in). Two transforms
 * reconcile that with pdf-lib's user space, innermost first:
 *   1. intrinsicMatrix — on a source page with intrinsic /Rotate, convert visual → unrotated
 *      (still 0-based); the page's /Rotate then displays them where the user placed them.
 *   2. translate by the view-box origin — so a page whose MediaBox/CropBox doesn't start at (0,0)
 *      draws at the visible content, not offset by the origin. Mirrors the crop path (setCropBox
 *      uses view0.x + u.x). Without it every flattened overlay — text, ink, shapes, images, the
 *      signature appearance, formValue marks — and the OCR layer is shifted on offset pages.
 *
 * `draw.prepend` receives that pair and writes its own stream at the FRONT of /Contents (the OCR
 * layer, which carries the same `q [view cm] [intrinsic cm] … Q` inside its own stream, since an
 * appended wrapper cannot reach a prepended stream). `draw.append` runs with the pair applied by a
 * `q … Q` wrapper around the operators it appends (pushOperators), skipped when both are identity.
 * Either may be absent, so the space is set up whether the page has overlays, OCR, or both.
 */
async function withPageSpace(
  page: PDFPage,
  intrinsic: number,
  view0: Box,
  draw: { prepend?: (space: OcrPageSpace) => void; append?: () => Promise<void> }
): Promise<void> {
  const space = pageSpace(intrinsic, view0)
  // pdf-lib wraps the existing content in q … Q (normalize) the first time it appends operators.
  // Doing that now, before the prepend, keeps the OCR layer the FIRST stream of /Contents.
  if (draw.prepend && draw.append) page.node.normalize()
  draw.prepend?.(space)
  if (!draw.append) return
  const m = space.intrinsic
  const shift = view0.x !== 0 || view0.y !== 0
  if (!m && !shift) return draw.append()
  page.pushOperators(pushGraphicsState())
  if (shift) page.pushOperators(concatTransformationMatrix(1, 0, 0, 1, view0.x, view0.y))
  if (m) page.pushOperators(concatTransformationMatrix(...m))
  await draw.append()
  page.pushOperators(popGraphicsState())
}

/**
 * The annotation dict plus its /Parent chain (an AcroForm field can inherit /T and /FT from
 * ancestors), bounded so a cyclic /Parent can't hang the export.
 */
function* fieldChain(ctx: PDFDocument['context'], dict: PDFDict): Generator<PDFDict> {
  let d: PDFDict | undefined = dict
  for (let guard = 0; d && guard < 32; guard++) {
    yield d
    const parent = d.get(PDFName.of('Parent'))
    d =
      parent instanceof PDFRef
        ? ctx.lookupMaybe(parent, PDFDict)
        : parent instanceof PDFDict
          ? parent
          : undefined
  }
}

/** Fully-qualified AcroForm field name of a widget annotation (walks the /Parent chain). */
function widgetFieldName(ctx: PDFDocument['context'], dict: PDFDict): string | undefined {
  const parts: string[] = []
  for (const d of fieldChain(ctx, dict)) {
    const t = d.get(PDFName.of('T'))
    if (t instanceof PDFString || t instanceof PDFHexString) parts.unshift(t.decodeText())
  }
  return parts.length ? parts.join('.') : undefined
}

/** A widget annotation whose field type is /Sig (directly or inherited via the /Parent chain). */
function isSignatureWidget(ctx: PDFDocument['context'], dict: PDFDict): boolean {
  if (dict.get(PDFName.of('Subtype')) !== PDFName.of('Widget')) return false
  for (const d of fieldChain(ctx, dict)) {
    if (d.get(PDFName.of('FT')) === PDFName.of('Sig')) return true
  }
  return false
}

/** Rewrite a page's /Annots, dropping every resolvable annotation the predicate selects. */
function dropAnnots(
  page: PDFPage,
  drop: (dict: PDFDict, ctx: PDFDocument['context']) => boolean
): void {
  const annots = page.node.Annots()
  if (!annots) return
  const ctx = page.doc.context
  const keep: Array<ReturnType<typeof annots.get>> = []
  for (let i = 0; i < annots.size(); i++) {
    const ref = annots.get(i)
    const dict = ref instanceof PDFRef ? ctx.lookupMaybe(ref, PDFDict) : ref instanceof PDFDict ? ref : undefined // prettier-ignore
    if (dict && drop(dict, ctx)) continue
    keep.push(ref)
  }
  page.node.set(PDFName.of('Annots'), ctx.obj(keep))
}

/**
 * Remove the interactive widget annotations of fields we've FILLED (painted) so the original
 * widget appearance (its old value) doesn't double with the flattened value — and a cleared field
 * doesn't keep showing its old value. Untouched fields keep their widgets (and pre-filled values).
 */
function removeFilledWidgets(page: PDFPage, filled: Set<string>): void {
  dropAnnots(page, (dict, ctx) => {
    if (dict.get(PDFName.of('Subtype')) !== PDFName.of('Widget')) return false
    const name = widgetFieldName(ctx, dict)
    return !!name && filled.has(name)
  })
}

/**
 * Drop signature-field widget annotations from a flattened page. A PDF that's about to be signed must
 * not carry an *empty* signature field — a viewer (Adobe) would render it as a dangling "click to
 * sign here" field alongside our actual signature. And any already-signed source field is invalidated
 * by the flatten (copyPages) anyway, so its now-meaningless widget should go too. Our own signature is
 * added separately by the signer.
 */
function removeSignatureWidgets(page: PDFPage): void {
  dropAnnots(page, (dict, ctx) => isSignatureWidget(ctx, dict))
}

async function bakePage(
  page: PDFPage,
  exportPage: ExportPage,
  edits: EditLayer | undefined,
  res: FlattenResources | undefined,
  ocr?: { bake: OcrBake; ordinal: number }
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
  // Drop every overlay a redaction covers BEFORE flattening — the exact rule the .pdfx mirror uses
  // (mirror.ts's stripRedactedOverlays). The redaction box only PAINTS over what sits beneath it:
  // an overlay baked underneath still emits its own operators, so a covered text overlay's `Tj`
  // stays in the content stream and comes back out of copy-paste / pdftotext. Redactions are kept
  // here (unlike in the mirror) because the box must still cover the hole the destructive PDFium
  // pass left in the SOURCE content. This also makes .pdf and .pdfx exports agree on what survives.
  const visible = list ? stripRedactedOverlays(list, { keepRedactions: true }) : undefined
  const sorted =
    res && visible && visible.length > 0
      ? [...visible].sort((a, b) => a.z - b.z || a.createdAt - b.createdAt)
      : undefined
  // The OCR layer (DESIGN.md §3.7.2): words lie in the same overlay frame. On PDF export, words
  // entirely outside the visible box after the edit crop are dropped (§3.7.5), so cropped-away
  // content does not become searchable in other viewers; partly visible words are kept.
  let ocrPage = ocr ? ocrPageFor(edits, key) : undefined
  if (ocrPage) {
    const quarter = intrinsic === 90 || intrinsic === 270
    const visual = quarter
      ? { width: view0.height, height: view0.width }
      : { width: view0.width, height: view0.height }
    ocrPage = dropWordsOutside(ocrPage, visibleBox(visual, crop)) ?? undefined
  }
  const layer = ocr && ocrPage ? { ...ocr, page: ocrPage } : undefined
  await withPageSpace(page, intrinsic, view0, {
    prepend: layer
      ? (space) => void bakeOcrLayer(page, layer.page, layer.bake, layer.ordinal, space)
      : undefined,
    append: sorted && res ? () => flattenPageOverlays(page, sorted, res) : undefined
  })
  // Form fill paints the value as page content; drop the matching interactive widget so its own
  // appearance (the original value) doesn't render on top of — and double with — the painted one.
  // Deliberately computed from the FULL list, not `visible`: a formValue overlay a redaction covers
  // still needs its widget gone, or the widget's appearance stream would paint the original value
  // over the black box (annotations render above page content).
  if (list) {
    const filled = new Set(
      list
        .filter((o) => o.type === 'formValue')
        .map((o) => (o as Extract<Overlay, { type: 'formValue' }>).field)
    )
    if (filled.size) removeFilledWidgets(page, filled)
  }
}

/** Tag a failure with the output page it happened on, so one bad source is identifiable. */
function pageError(ordinal: number, page: ExportPage, e: unknown): Error {
  return new Error(
    `Export failed on page ${ordinal} (source page ${page.pageIndex + 1}): ${e instanceof Error ? e.message : String(e)}`
  )
}

/**
 * Copy every export page into `output`, returning the copied pages in the SAME order as `pages`
 * (not yet added to the page tree).
 *
 * pdf-lib dedupes shared objects only within ONE copyPages call (each call builds a fresh object
 * copier), so copying page-by-page re-copied every object two pages share — a letterhead logo, a
 * font, a repeated scan — once per page: a 3.7 MB JPEG on two pages exported as 7.4 MB. Instead,
 * each source's pages are copied in a single batch, so a shared image/font lands in the output once.
 *
 * A page that appears more than once in the collection goes into a LATER batch per repeat (the
 * Nth occurrence of each page joins batch N for its source). Within one copier a repeated page
 * would share its direct /Contents and /Annots containers — and the very same annotation dicts —
 * with the first copy, so the copies stay fully independent exactly as before (at the cost of
 * re-copying that page's resources, which only a deliberate duplicate pays).
 */
async function copyExportPages(
  output: PDFDocument,
  pages: ExportPage[]
): Promise<{ copied: PDFPage[]; sources: PDFDocument[] }> {
  const sources = new Map<string, PDFDocument>()
  const occurrences = new Map<string, number>()
  // Insertion-ordered: batch key (source + repeat round) -> the output slots it fills.
  const batches = new Map<string, { source: PDFDocument; slots: number[] }>()
  for (let slot = 0; slot < pages.length; slot++) {
    const page = pages[slot]
    let source = sources.get(page.sourceKey)
    if (!source) {
      try {
        source = await PDFDocument.load(page.bytes, { ignoreEncryption: true })
      } catch (e) {
        throw pageError(slot + 1, page, e)
      }
      sources.set(page.sourceKey, source)
    }
    const pageKey = makePageKey(page.sourceKey, page.pageIndex)
    const round = occurrences.get(pageKey) ?? 0
    occurrences.set(pageKey, round + 1)
    // JSON keeps the (arbitrary-string) sourceKey and the round unambiguously separated.
    const batchKey = JSON.stringify([page.sourceKey, round])
    let batch = batches.get(batchKey)
    if (!batch) batches.set(batchKey, (batch = { source, slots: [] }))
    batch.slots.push(slot)
  }

  const copied = new Array<PDFPage>(pages.length)
  for (const { source, slots } of batches.values()) {
    let result: PDFPage[]
    try {
      result = await output.copyPages(
        source,
        slots.map((s) => pages[s].pageIndex)
      )
    } catch (batchError) {
      // A batch failure doesn't say which page broke it. Re-copy the batch page by page to name
      // the culprit (the output document is discarded on any throw, so the strays don't matter).
      for (const s of slots) {
        try {
          await output.copyPages(source, [pages[s].pageIndex])
        } catch (e) {
          throw pageError(s + 1, pages[s], e)
        }
      }
      throw pageError(slots[0] + 1, pages[slots[0]], batchError)
    }
    slots.forEach((s, i) => (copied[s] = result[i]))
  }
  return { copied, sources: [...sources.values()] }
}

/**
 * Give a copied page private copies of the containers that baking MUTATES IN PLACE — the
 * /Contents array (pushOperators appends to it), /Annots, and /Resources with its Font, XObject
 * and ExtGState sub-dicts (drawText/drawImage register names there). Pages copied in one batch
 * share whatever the source shared: an indirect /Resources dict common to every page (typical of
 * scanners) or even a shared indirect /Contents array. Without this an overlay baked onto one page
 * would append its content stream to — and render on — every page sharing that array. The leaf
 * objects (content streams, images, fonts) stay shared; that's the dedupe we want.
 */
function isolateMutableContainers(page: PDFPage): void {
  const node = page.node
  const ctx = node.context
  const contentsEntry = node.get(PDFName.of('Contents'))
  const contents = contentsEntry ? ctx.lookup(contentsEntry) : undefined
  if (contents instanceof PDFArray) node.set(PDFName.of('Contents'), ctx.obj(contents.asArray()))
  const annots = node.Annots()
  if (annots) node.set(PDFName.of('Annots'), ctx.obj(annots.asArray()))
  const resources = node.Resources()
  if (resources) {
    const own = resources.clone(ctx)
    for (const name of ['Font', 'XObject', 'ExtGState']) {
      const sub = own.lookupMaybe(PDFName.of(name), PDFDict)
      if (sub) own.set(PDFName.of(name), sub.clone(ctx))
    }
    node.set(PDFName.of('Resources'), own)
  }
}

export async function buildPdf(
  pages: ExportPage[],
  edits?: EditLayer,
  opts?: { stripSignatureFields?: boolean }
): Promise<Uint8Array> {
  const output = await PDFDocument.create()
  const res = edits ? createFlattenResources(output, edits.attachments) : undefined
  // One OCR font per output document (a zip builds one per entry): its tables come only from the
  // words baked into THIS document (redaction rule 5).
  const bake = newOcrBake(output, edits)
  const { copied, sources } = await copyExportPages(output, pages)
  for (let i = 0; i < pages.length; i++) {
    const page = copied[i]
    // Tag any failure with which page failed, so a single bad source (e.g. one odd scan) is
    // identifiable instead of surfacing as a bare "Export failed".
    try {
      output.addPage(page)
      isolateMutableContainers(page)
      // Before signing, strip empty/leftover signature fields so the signed PDF has only our
      // signature — not a dangling "sign here" field Adobe would offer to sign.
      if (opts?.stripSignatureFields) removeSignatureWidgets(page)
      await bakePage(page, pages[i], edits, res, bake && { bake, ordinal: i })
    } catch (e) {
      throw pageError(i + 1, pages[i], e)
    }
  }
  finishOcr(output, bake, pages.length, sources, `PDFX ${PDFX_VERSION}`)
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

  // .pdfx keeps pages CLEAN — overlays/rotation are stored in the manifest mirror instead of
  // baked in, so the file reopens fully editable. Export PDF produces the flattened, shareable
  // copy (any viewer sees the annotations there). Pages are copied across ALL documents at once so
  // an image shared between documents of the same source is also stored once; failures name the
  // page by its ordinal across documents, as buildPdf does.
  const ordered = documents.flatMap((doc) => doc.pages)
  const { copied, sources } = await copyExportPages(output, ordered)
  for (const page of copied) output.addPage(page)

  // The one exception to clean pages: the OCR text layer is BAKED (DESIGN.md §3.7.2), so a
  // reopened .pdfx is searchable without re-recognition, and it is baked BEFORE computeIntegrity
  // so the pdfx-canon/1 tamper hash covers it. Only those pages are mutated, so only they get
  // private containers. Rotation and crop stay live mirror edits: words keep the source visual
  // frame (intrinsic + view-origin matrices only), and every word is kept (no crop drop).
  const bake = newOcrBake(output, edits)
  if (bake) {
    for (let i = 0; i < ordered.length; i++) {
      const ocrPage = ocrPageFor(edits, makePageKey(ordered[i].sourceKey, ordered[i].pageIndex))
      if (!ocrPage) continue
      const page = copied[i]
      try {
        isolateMutableContainers(page)
        const intrinsic = ((page.getRotation().angle % 360) + 360) % 360
        const view0 = viewBox(page.getCropBox(), page.getMediaBox())
        await withPageSpace(page, intrinsic, view0, {
          prepend: (space) => void bakeOcrLayer(page, ocrPage, bake, i, space)
        })
      } catch (e) {
        throw pageError(i + 1, ordered[i], e)
      }
    }
  }

  for (const doc of documents) {
    if (doc.pages.length === 0) continue
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
  // Font tables, Producer + XMP marking and the catalog /Lang, before computeIntegrity and save;
  // after the mirror, because the Producer names the manifest version, which it can raise to 1.1.
  finishOcr(output, bake, ordered.length, sources, `PDFX ${manifest.pdfx}`)

  // pdfx-canon/1 tamper record over the assembled page content, computed BEFORE the manifest is
  // attached so the manifest itself is excluded from the hash (PRD §4.6). Best-effort: the record is
  // advisory, so a compute failure on an odd source skips it rather than failing the whole export.
  try {
    manifest.integrity = await computeIntegrity(output)
  } catch (e) {
    console.warn('pdfx: integrity record skipped', e)
  }

  await output.attach(new TextEncoder().encode(JSON.stringify(manifest, null, 2)), MANIFEST_NAME, {
    mimeType: 'application/json',
    description: 'PDFX manifest describing the documents in this collection',
    creationDate: new Date(),
    modificationDate: new Date()
  })

  output.setTitle(title)
  output.setKeywords(['PDFX'])

  try {
    return await output.save()
  } catch (e) {
    throw new Error(
      `Export failed while writing the combined PDF: ${e instanceof Error ? e.message : String(e)}`
    )
  }
}
