// The PDFx OCR layer a reopened file already carries (DESIGN.md §3.5.2, §3.6.3): what "Show
// recognized text" draws on a page whose words were recognised in an EARLIER session. Its words
// are native pdf.js text by now, inside the layer's `/PDFxOCR … BDC … EMC` marked content
// (pdfx/ocr-layer.ts), so they are read with pdf.js's marked-content items. Per-word confidence
// is not saved (D8: provenance only), so these words carry none and are never underlined.
//
// pdf.js merges a line's per-word Tj's into one item, so a "word" here is a line run: its box and
// text are the run's. Type-only pdf.js imports: nothing here loads pdf.js at runtime.

import type { PDFDocumentProxy } from 'pdfjs-dist'

/** pdfx/ocr-layer.ts `OCR_MARK` (not imported: that module pulls in pdf-lib). */
export const SAVED_LAYER_TAG = 'PDFxOCR'

/** One run of the saved layer, in display page coordinates (top-left origin, y down, pt). */
export interface SavedRun {
  t: string
  /** Baseline start. */
  x: number
  y: number
  /** Advance along the baseline. */
  w: number
  /** Em size (the layer's line size). */
  size: number
  /** Baseline rotation, degrees clockwise on screen. */
  deg: number
}

type M6 = readonly number[]

const mul = (m: M6, n: M6): number[] => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5]
]

interface RawItem {
  str?: unknown
  transform?: unknown
  width?: unknown
  type?: unknown
  tag?: unknown
}

/**
 * The runs inside `/PDFxOCR` marked content of one page's text content (`items` from
 * `getTextContent({ includeMarkedContent: true })`), mapped through `vt` (the page's scale-1
 * viewport transform). Exported for tests.
 */
export function savedRuns(items: readonly unknown[], vt: M6): SavedRun[] {
  const out: SavedRun[] = []
  // A stack of open marked-content sections: true where one is (or is inside) the layer.
  const stack: boolean[] = []
  const unit = Math.hypot(vt[0], vt[1]) || 1
  for (const raw of items) {
    const it = raw as RawItem
    if (it.type === 'beginMarkedContent' || it.type === 'beginMarkedContentProps') {
      stack.push(stack.at(-1) === true || it.tag === SAVED_LAYER_TAG)
      continue
    }
    if (it.type === 'endMarkedContent') {
      stack.pop()
      continue
    }
    if (stack.at(-1) !== true) continue
    if (typeof it.str !== 'string' || !Array.isArray(it.transform)) continue
    const t = it.str.trim()
    if (!t) continue
    const tr = it.transform as number[]
    if (tr.length !== 6 || !tr.every(Number.isFinite)) continue
    const m = mul(vt, tr)
    const size = Math.hypot(m[2], m[3])
    const w = (typeof it.width === 'number' && Number.isFinite(it.width) ? it.width : 0) * unit
    if (!(size > 0)) continue
    out.push({ t, x: m[4], y: m[5], w, size, deg: (Math.atan2(m[1], m[0]) * 180) / Math.PI })
  }
  return out
}

const cache = new WeakMap<object, Map<number, Promise<SavedRun[]>>>()

/**
 * The saved PDFx OCR layer of page `pageIndex` (empty when the page has none, or its text cannot
 * be read). Cached per document proxy and page: a source is immutable.
 */
export function readSavedLayer(pdf: PDFDocumentProxy, pageIndex: number): Promise<SavedRun[]> {
  let pages = cache.get(pdf)
  if (!pages) cache.set(pdf, (pages = new Map()))
  let p = pages.get(pageIndex)
  if (!p) {
    p = (async () => {
      try {
        const page = await pdf.getPage(pageIndex + 1)
        const vt = page.getViewport({ scale: 1 }).transform
        const content = await page.getTextContent({ includeMarkedContent: true })
        return savedRuns(content.items, vt)
      } catch {
        return []
      }
    })()
    pages.set(pageIndex, p)
  }
  return p
}
