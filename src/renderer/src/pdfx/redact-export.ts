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

import { makePageKey, type Overlay } from '../edit/model'
import type { DocEntry, PageEntry } from '../types'
import type { EditLayer } from './build'
import { unrotateCrop } from './build'
import type { FrameBox } from './ocr-export'
import { getPdfium } from './pdfium'
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
 * is `view` = [x0, y0, x1, y1] and whose intrinsic /Rotate is `rotate`. Null (unknown) → UNKNOWN.
 */
export function pdfBoxToFrame(
  box: PdfBox | null,
  view: readonly number[],
  rotate: number
): FrameBox {
  if (!box) return UNKNOWN
  const u = { x: box.l - view[0], y: box.b - view[1], w: box.r - box.l, h: box.t - box.b }
  const out = rotateToVisual(u, rotate, view[2] - view[0], view[3] - view[1])
  return [out.x, out.y, out.w, out.h].every(Number.isFinite) ? out : UNKNOWN
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
    const frames = new Map<number, { view: number[]; rotate: number }>()
    let sourceBytes: Uint8Array | null = null
    for (const [pageIndex, reds] of pages) {
      const entry = pageByKey.get(makePageKey(sourceKey, pageIndex))
      if (!entry) continue
      sourceBytes = entry.source.bytes
      // page.view = [x0, y0, x1, y1]: the visible box (CropBox ∩ MediaBox) in UNROTATED user space.
      // Editor overlay coords are relative to its lower-left, so convert each box's DIMENSIONS via
      // the page's intrinsic /Rotate AND add the view-box ORIGIN — exactly as the crop export does.
      // Omitting the origin mis-places (and leaks) redactions on any non-(0,0)-origin page.
      const proxy = await entry.source.pdf.getPage(pageIndex + 1)
      const rotate = (((proxy.rotate % 360) + 360) % 360) as number
      const view = proxy.view
      frames.set(pageIndex, { view, rotate })
      const uw = view[2] - view[0]
      const uh = view[3] - view[1]
      const rects: RedactRect[] = reds.map((o) => {
        const u = unrotateCrop(
          { x: o.geom.x, y: o.geom.y, w: o.geom.w, h: o.geom.h },
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
    out.set(sourceKey, result.bytes)
    if (!out.removed) continue
    for (const { pageIndex } of pageRedactions) {
      const frame = frames.get(pageIndex)!
      const objs = result.removed.get(pageIndex)
      // No entry from the pass for a page it was given: unknown, so the whole layer goes.
      const rects = objs
        ? objs.map((o) => pdfBoxToFrame(o.box, frame.view, frame.rotate))
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
