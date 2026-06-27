// Redaction export pre-pass. Redaction overlays are applied DESTRUCTIVELY (content removed via the
// PDFium engine) to the source PDFs before assembly, for BOTH .pdfx and plain-PDF export — never
// deferred to the editable mirror, since a ".pdfx with redactions" must not still contain the data.
// Editor box coordinates are in pdf.js visual space; they are converted to the unrotated user space
// the engine expects with unrotateCrop (the same transform crop/overlay export uses).

import { makePageKey, type Overlay } from '../edit/model'
import type { DocEntry, PageEntry } from '../types'
import type { EditLayer } from './build'
import { unrotateCrop } from './build'
import { getPdfium } from './pdfium'
import { redactPdf, type PageRedaction, type PdfiumModule, type RedactRect } from './redact'

interface SourcePage {
  sourceKey: string
  bytes: Uint8Array
  pageIndex: number
}

/**
 * For every source PDF that has any redaction overlay, return its redacted bytes (content under
 * each box removed). Sources without redactions are absent from the map. Empty when nothing is
 * redacted, so callers can skip the (WASM) work entirely.
 */
export async function buildRedactedSources(
  editLayer: EditLayer,
  docs: DocEntry[],
  pdfiumModule?: PdfiumModule
): Promise<Map<string, Uint8Array>> {
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
  if (bySource.size === 0) return new Map()

  const pdfium = pdfiumModule ?? (await getPdfium())
  const out = new Map<string, Uint8Array>()
  for (const [sourceKey, pages] of bySource) {
    const pageRedactions: PageRedaction[] = []
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
    if (sourceBytes) out.set(sourceKey, redactPdf(pdfium, sourceBytes, pageRedactions))
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
