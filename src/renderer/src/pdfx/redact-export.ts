// Redaction export pre-pass. Redaction overlays are applied DESTRUCTIVELY (content removed via the
// PDFium engine) to the source PDFs before assembly, for BOTH .pdfx and plain-PDF export — never
// deferred to the editable mirror, since a ".pdfx with redactions" must not still contain the data.
// Editor box coordinates are in pdf.js visual space; they are converted to the unrotated user space
// the engine expects with unrotateCrop (the same transform crop/overlay export uses).
//
// With `report: true` the pass also returns what it removed (DESIGN.md §3.7.1, §3.7.3 rule 2):
// `removed` maps the page key of EVERY redacted page to the bounds of every object and annotation
// the pass took off it, converted back into the overlay frame the OCR words live in (the inverse of
// the box conversion: view-box origin, then the source's intrinsic /Rotate). ocr-export.ts drops
// the recognised words that lie over any of them. An extent PDFium could not give is a non-finite
// rect, which makes the export drop that page's whole layer.
//
// /UserUnit: pdf.js scales a page's frame by its UserUnit (a 400 pt page with /UserUnit 2 is an
// 800-unit frame), so the frame → user space conversion divides by it and the report multiplies
// back. build.ts `pageSpace` does the same for overlays, crop and the OCR layer.
//
// After the PDFium pass, `sanitizeRedacted` cleans what PDFium leaves of a redacted page in the
// pdf-lib object model, because copyPages carries every entry of the page dict along:
// - the page's side copies of its content: /PieceInfo (an Illustrator AIPrivateData stream is the
//   page's full editable original), /Thumb (a thumbnail of the unredacted page), /Metadata (XMP)
//   and /SeparationInfo;
// - an annotation whose /IRT, or a popup whose /Parent, names an annotation the page no longer
//   lists (a second guard behind redact.ts `linkedAnnots`);
// - font residue (font-trim.ts `trimFonts`): every font's character tables and TrueType outlines
//   are cut to the codes the document still shows;
// then deletes the objects that unlinked. (build.ts `pruneDetached` drops what an EXPORT still
// does not reach, such as a page dragged in by a link from another copy of the same file.)

import { PDFDict, PDFDocument, PDFName, PDFRef, type PDFObject } from 'pdf-lib'

import { makePageKey, type Overlay } from '../edit/model'
import type { DocEntry, PageEntry } from '../types'
import type { EditLayer } from './build'
import { unrotateCrop, userUnitOf } from './build'
import { trimFonts } from './font-trim'
import type { FrameBox } from './ocr-export'
import { getPdfium } from './pdfium'
import { deleteUnreachable, forEachRef } from './reachable'
import {
  redactPdfReport,
  type PageRedaction,
  type PdfBox,
  type PdfiumModule,
  type RedactRect
} from './redact'

interface SourcePage {
  sourceKey: string
  bytes: Uint8Array
  pageIndex: number
}

/**
 * sourceKey → redacted bytes (sources without redactions are absent), plus, when the pass was asked
 * to report, `removed`: page key → the removed objects' bounds in the overlay frame.
 */
export interface RedactedSources extends Map<string, Uint8Array> {
  removed?: Map<string, FrameBox[]>
}

export interface RedactedSourcesOptions {
  /** Return the removed-object report in `removed` (every export path that may bake OCR asks). */
  report?: boolean
  /** The initialised PDFium module (tests); default: the app's shared instance. */
  pdfium?: PdfiumModule
}

/** A rect of unknown extent: non-finite, so ocr-export.ts drops the page's whole layer. */
const UNKNOWN: FrameBox = Object.freeze({ x: NaN, y: NaN, w: NaN, h: NaN })

/**
 * The inverse of `unrotateCrop`: a rect in the page's unrotated, view-relative user space back into
 * the editor's visual frame (the source's intrinsic /Rotate baked in). (W, H) are the unrotated
 * view-box dimensions.
 */
export function rotateToVisual(u: FrameBox, intrinsic: number, W: number, H: number): FrameBox {
  switch (intrinsic) {
    case 90:
      return { x: u.y, y: W - u.x - u.w, w: u.h, h: u.w }
    case 180:
      return { x: W - u.x - u.w, y: H - u.y - u.h, w: u.w, h: u.h }
    case 270:
      return { x: H - u.y - u.h, y: u.x, w: u.h, h: u.w }
    default:
      return { x: u.x, y: u.y, w: u.w, h: u.h }
  }
}

/**
 * A PDFium box (absolute unrotated user space) → the overlay frame of a page whose pdf.js view box
 * is `view` = [x0, y0, x1, y1], whose intrinsic /Rotate is `rotate` and whose /UserUnit is `unit`.
 * Null (unknown) → UNKNOWN.
 */
export function pdfBoxToFrame(
  box: PdfBox | null,
  view: readonly number[],
  rotate: number,
  unit = 1
): FrameBox {
  if (!box) return UNKNOWN
  const u = { x: box.l - view[0], y: box.b - view[1], w: box.r - box.l, h: box.t - box.b }
  const v = rotateToVisual(u, rotate, view[2] - view[0], view[3] - view[1])
  const out = { x: v.x * unit, y: v.y * unit, w: v.w * unit, h: v.h * unit }
  return [out.x, out.y, out.w, out.h].every(Number.isFinite) ? out : UNKNOWN
}

/** Page-dict entries holding another copy of the page's content (see the header). */
export const PAGE_SIDE_DATA: readonly string[] = [
  'PieceInfo',
  'Thumb',
  'Metadata',
  'SeparationInfo'
]

/**
 * `bytes` (a PDFium-redacted document) with the redacted pages' side data, orphaned replies and
 * popups, and every font's residue removed (see the header).
 */
export async function sanitizeRedacted(
  bytes: Uint8Array,
  pageIndices: Iterable<number>
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true })
  const ctx = doc.context
  const unlinked: PDFRef[] = []
  const collect = (o: PDFObject | undefined): void => {
    if (o instanceof PDFRef) unlinked.push(o)
    else forEachRef(o, (r) => unlinked.push(r))
  }
  const pages = doc.getPages()
  for (const i of pageIndices) {
    const node = pages[i]?.node
    if (!node) continue
    for (const key of PAGE_SIDE_DATA) {
      const v = node.get(PDFName.of(key))
      if (v === undefined) continue
      node.delete(PDFName.of(key))
      collect(v)
    }
    const annots = node.Annots()
    if (!annots) continue
    const dictOf = (o: PDFObject | undefined): PDFDict | undefined =>
      o instanceof PDFRef ? ctx.lookupMaybe(o, PDFDict) : o instanceof PDFDict ? o : undefined
    const listed = new Set(
      annots
        .asArray()
        .map(dictOf)
        .filter((d): d is PDFDict => !!d)
    )
    /** An annotation (not a form field) the page does not list. */
    const unlisted = (o: PDFObject | undefined): boolean => {
      const d = dictOf(o)
      return !!d && d.get(PDFName.of('Subtype')) instanceof PDFName && !listed.has(d)
    }
    const keep: PDFObject[] = []
    for (const a of annots.asArray()) {
      const d = dictOf(a)
      const orphan =
        !!d &&
        (unlisted(d.get(PDFName.of('IRT'))) ||
          (d.get(PDFName.of('Subtype')) === PDFName.of('Popup') && unlisted(d.get(PDFName.of('Parent'))))) // prettier-ignore
      if (orphan) collect(a)
      else keep.push(a)
    }
    if (keep.length !== annots.size()) node.set(PDFName.of('Annots'), ctx.obj(keep))
  }
  // An encrypted source's streams cannot be read here, so their fonts cannot be scanned.
  if (!doc.isEncrypted) unlinked.push(...trimFonts(doc).unlinked)
  deleteUnreachable(ctx, unlinked)
  return doc.save({ useObjectStreams: false, updateFieldAppearances: false })
}

/**
 * For every source PDF that has any redaction overlay, return its redacted bytes (content under
 * each box removed). Sources without redactions are absent from the map. Empty when nothing is
 * redacted, so callers can skip the (WASM) work entirely. With `report`, `removed` is always set
 * (empty when nothing is redacted) and holds an entry for every redacted page.
 */
export async function buildRedactedSources(
  editLayer: EditLayer,
  docs: DocEntry[],
  opts: RedactedSourcesOptions = {}
): Promise<RedactedSources> {
  const out: RedactedSources = new Map<string, Uint8Array>()
  if (opts.report) out.removed = new Map()
  const pageByKey = new Map<string, PageEntry>()
  for (const doc of docs) {
    for (const p of doc.pages) pageByKey.set(makePageKey(p.source.id, p.pageIndex), p)
  }

  // sourceKey -> (pageIndex -> its redaction overlays)
  const bySource = new Map<string, Map<number, Overlay[]>>()
  for (const [pageKey, overlays] of editLayer.overlays) {
    const reds = overlays.filter((o) => o.type === 'redaction')
    if (reds.length === 0) continue
    const entry = pageByKey.get(pageKey)
    if (!entry) continue
    let pages = bySource.get(entry.source.id)
    if (!pages) {
      pages = new Map()
      bySource.set(entry.source.id, pages)
    }
    pages.set(entry.pageIndex, reds)
  }
  if (bySource.size === 0) return out

  const pdfium = opts.pdfium ?? (await getPdfium())
  for (const [sourceKey, pages] of bySource) {
    const pageRedactions: PageRedaction[] = []
    /** pageIndex → its pdf.js frame, to convert the report back. */
    const frames = new Map<number, { view: number[]; rotate: number; unit: number }>()
    let sourceBytes: Uint8Array | null = null
    for (const [pageIndex, reds] of pages) {
      const entry = pageByKey.get(makePageKey(sourceKey, pageIndex))
      if (!entry) continue
      sourceBytes = entry.source.bytes
      // page.view = [x0, y0, x1, y1]: the visible box (CropBox ∩ MediaBox) in UNROTATED user space.
      // Editor overlay coords are relative to its lower-left, so convert each box's DIMENSIONS via
      // the page's intrinsic /Rotate AND add the view-box ORIGIN — exactly as the crop export does.
      // Omitting the origin mis-places (and leaks) redactions on any non-(0,0)-origin page.
      // The frame is in UserUnit-scaled units (pdf.js multiplies its viewport by it): divide first.
      const proxy = await entry.source.pdf.getPage(pageIndex + 1)
      const rotate = (((proxy.rotate % 360) + 360) % 360) as number
      const view = proxy.view
      const unit = userUnitOf((proxy as { userUnit?: unknown }).userUnit)
      frames.set(pageIndex, { view, rotate, unit })
      const uw = view[2] - view[0]
      const uh = view[3] - view[1]
      const rects: RedactRect[] = reds.map((o) => {
        const u = unrotateCrop(
          { x: o.geom.x / unit, y: o.geom.y / unit, w: o.geom.w / unit, h: o.geom.h / unit },
          rotate,
          uw,
          uh
        )
        return { x: view[0] + u.x, y: view[1] + u.y, w: u.w, h: u.h }
      })
      pageRedactions.push({ pageIndex, rects })
    }
    if (!sourceBytes) continue
    // OCR fail-safe for reopened OCR'd files (DESIGN.md §3.7.3 rules 2 and 5): a redacted page
    // loses its WHOLE PDFx OCR layer, not just the words under the box. Removing only those words
    // would leave their characters in the layer font's ToUnicode, which copyPages carries into the
    // export with the page. With no text object left in the font, FPDFPage_GenerateContent drops
    // the page's /FOcr resource and the no-incremental save writes no orphaned font [measured,
    // tmp probe; pinned by ocr-export.node.test.ts "a reopened OCR'd export": no OCR font is
    // bound on the redacted page and the raw-bytes oracle finds no redacted character].
    const result = redactPdfReport(pdfium, sourceBytes, pageRedactions, { dropOcrText: true })
    out.set(sourceKey, await sanitizeRedacted(result.bytes, frames.keys()))
    if (!out.removed) continue
    for (const { pageIndex } of pageRedactions) {
      const frame = frames.get(pageIndex)!
      const objs = result.removed.get(pageIndex)
      // No entry from the pass for a page it was given: unknown, so the whole layer goes.
      const rects = objs
        ? objs.map((o) => pdfBoxToFrame(o.box, frame.view, frame.rotate, frame.unit))
        : [UNKNOWN]
      out.removed.set(makePageKey(sourceKey, pageIndex), rects)
    }
  }
  return out
}

/** Swap in redacted source bytes for the pages whose source was redacted. */
export function applyRedactedBytes<T extends SourcePage>(
  pages: T[],
  redacted: Map<string, Uint8Array>
): T[] {
  if (redacted.size === 0) return pages
  return pages.map((p) => {
    const bytes = redacted.get(p.sourceKey)
    return bytes ? { ...p, bytes } : p
  })
}
