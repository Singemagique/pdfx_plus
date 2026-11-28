// The product-metric harness for Find over recognised text (DESIGN.md §3.9.2 "Find recall",
// "hit-on-target"): pages go through the REAL search engine (search/engine.ts: extraction, the
// supplement, redaction filtering, normalisation, matching) and the REAL highlight geometry
// (search/geometry.ts), and `findScores` (PR1 metrics) scores the hit rects against the GT boxes.
// Test-only; every later tier (replayed engine output, tier-1 live OCR, the D2 bake-off) feeds it
// its own `OcrPage`s.
//
// A page's native text is read from PDF bytes with the shipped extractor (pdf.js 5.7.284 legacy
// build, in-process worker) — a scanned page has none, a reopened OCR'd page has its layer — or is
// given as a ready PageText. Recognised text is supplied exactly as the app will: once the page's
// native text is indexed, `ocrPageTextItems(ocr, vt, height)` → `setSupplement`.

import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { PDFDocumentProxy } from 'pdfjs-dist'
// Run pdf.js's worker in-process (its "fake worker": it picks up globalThis.pdfjsWorker).
import 'pdfjs-dist/legacy/build/pdf.worker.mjs'

import {
  findScores,
  fromTopLeft,
  type Box,
  type FindGtWord,
  type FindHit,
  type FindOptions,
  type FindScores
} from '../../../../shared/ocr/test-utils/metrics'
import { pack, type OcrPage, type PackedOcrPage } from '../../../../shared/ocr/types'
import type { DocEntry, PageEntry, PdfSource } from '../../types'
import { createFindEngine, type FindEngine } from '../../search/engine'
import { pageCopyText } from '../../search/copy-text'
import { extractPageText, type PageText } from '../../search/extract'
import { textMatchRects, type PageRect } from '../../search/geometry'
import { compileQuery, normalizeQuery } from '../../search/normalize'
import { ocrPageTextItems } from '../to-page-text'

export interface HarnessPage {
  /** Native text: a PDF (page `pageIndex`, default 0) read with pdf.js, or a ready PageText. */
  native: Uint8Array | PageText
  pageIndex?: number
  /** Visual page height (PageEntry.height: pdf.js viewport height at scale 1). */
  height: number
  /** Recognised text to supply, and how (default `append`). */
  ocr?: OcrPage | PackedOcrPage
  mode?: 'append' | 'replace'
  /** Redaction boxes in page px (top-left origin). */
  redactions?: PageRect[]
}

export interface FindHarness {
  engine: FindEngine
  /** Page key of page i. */
  keys: string[]
  /** One FindHit per match (the union of its rects), in the GT frame (bottom-left origin, pt). */
  search(query: string): FindHit[]
  /** Copy Page Text of page i, from the engine's effective items. */
  copyText(page: number): string
  /** findScores over `gt` with the app's own folding (normalizeQuery). */
  scores(gt: readonly FindGtWord[], opts?: FindOptions): Promise<FindScores>
  destroy(): Promise<void>
}

/** A stand-in pdf.js proxy for a page whose native text is given. */
class GivenText {
  constructor(readonly text: PageText) {}
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/** Build the engine over `pages`, index everything, then supply the recognised text. */
export async function createFindHarness(pages: readonly HarnessPage[]): Promise<FindHarness> {
  const proxies: PDFDocumentProxy[] = []
  const docs: DocEntry[] = []
  const keys: string[] = []
  for (const [i, p] of pages.entries()) {
    let pdf: unknown
    if (p.native instanceof Uint8Array) {
      const proxy = (await getDocument({ data: p.native.slice(), verbosity: 0 })
        .promise) as unknown as PDFDocumentProxy
      proxies.push(proxy)
      pdf = proxy
    } else pdf = new GivenText(p.native)
    const source = { id: `h${i}`, bytes: new Uint8Array(), pdf } as unknown as PdfSource
    const pageIndex = p.pageIndex ?? 0
    const page: PageEntry = { id: `h${i}-p`, source, pageIndex, width: 0, height: p.height }
    docs.push({ id: `d${i}`, name: `d${i}.pdf`, pages: [page] })
    keys.push(`h${i}#${pageIndex}`)
  }
  const engine = createFindEngine({
    onChange: () => {},
    extract: (pdf, pageIndex) =>
      pdf instanceof GivenText ? Promise.resolve(pdf.text) : extractPageText(pdf, pageIndex)
  })
  engine.reconcile(docs)
  engine.activate()
  for (let guard = 0; engine.progress().indexed < pages.length; guard++) {
    if (guard > 10_000) throw new Error('find-harness: indexing never finished')
    await settle()
  }
  pages.forEach((p, i) => {
    if (p.redactions) engine.setRedactions(keys[i], p.redactions)
    if (!p.ocr) return
    const vt = engine.getPageText(keys[i])!.vt
    const packed = 'lines' in p.ocr ? pack(p.ocr) : p.ocr
    engine.setSupplement(keys[i], {
      mode: p.mode ?? 'append',
      items: ocrPageTextItems(packed, vt, p.height)
    })
  })

  function search(query: string): FindHit[] {
    const norm = normalizeQuery(query)
    const re = compileQuery(norm)
    if (!re) return []
    const results = engine.search(norm, re)
    const hits: FindHit[] = []
    keys.forEach((key, page) => {
      const pm = results.get(key)
      const pt = engine.getPageText(key)
      if (!pm || !pt) return
      for (let j = 0; j < pm.text.length; j += 2) {
        const rects = textMatchRects(pt, pm.text[j], pm.text[j + 1])
        if (!rects.length) continue
        const x0 = Math.min(...rects.map((r) => r.x))
        const y0 = Math.min(...rects.map((r) => r.y))
        const x1 = Math.max(...rects.map((r) => r.x + r.w))
        const y1 = Math.max(...rects.map((r) => r.y + r.h))
        const box: Box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
        hits.push({ page, box: fromTopLeft(box, pages[page].height) })
      }
    })
    return hits
  }

  return {
    engine,
    keys,
    search,
    copyText: (page) => pageCopyText(engine.getPageText(keys[page])?.items ?? []),
    scores: (gt, opts) => findScores(gt, search, { fold: normalizeQuery, ...opts }),
    async destroy() {
      for (const p of proxies) await p.destroy()
    }
  }
}

/** A GT-frame box (bottom-left origin) → a page-px rect (top-left), e.g. for a redaction. */
export const toPageRect = (b: Box, pageHeight: number): PageRect => ({
  x: b.x,
  y: pageHeight - b.y - b.h,
  w: b.w,
  h: b.h
})
