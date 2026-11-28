// Stage 0 of OCR page selection (DESIGN.md §3.4.1): the cheap renderer-side gate that decides
// whether a source's bytes are worth sending to the OCR process for full (PDFium) triage at all.
// Opening an ordinary text PDF must never spawn the OCR process or copy its bytes.
//
// - Imported-image sources (`PdfSource.origin === 'image'`, from imageToPdf's Producer marker)
//   need no triage: PDFx made them from a photo, so they are recognised as such (D4).
// - Any other PDF: the search engine's own extractor (`search/extract.ts`, pdf.js
//   `getTextContent`) runs on the first min(8, pageCount) pages and on the page in view. A page
//   is a CANDIDATE if it has fewer than 200 visible non-space characters; the source goes to
//   triage if any page is one. (Find extracts every page when a search runs, so scans after page 8
//   surface then: `isCandidatePage` is the same test for that path.)
//
// pdf.js text items carry no render mode, so "visible" here counts every extracted non-space
// character, invisible (3 Tr) ones included. That errs towards NOT triaging a page that already
// has a text layer, which is right: such a page is `ocr-foreign` or `ocr-ours` and would be
// skipped anyway. PDFium decides the real class in Stage 1.
//
// This module only computes the decision. Spawning the OCR process, posting the bytes and the
// idle-priority scheduling belong to the renderer OCR store (PR7b), which passes an `extract`
// backed by the Find engine's write-once store so no page is extracted twice.

import { extractPageText, type PageText } from '../search/extract'
import type { PdfSource } from '../types'

/** Pages from the start of a source that Stage 0 reads. */
export const STAGE0_PAGES = 8
/** A page with fewer visible non-space characters than this is a candidate. */
export const CANDIDATE_MAX_CHARS = 200

/** Visible (extracted) non-whitespace characters of a page, by code point. */
export function visibleChars(pt: Pick<PageText, 'items'>): number {
  let n = 0
  for (const it of pt.items) for (const ch of it.str) if (!/\s/u.test(ch)) n++
  return n
}

/** A page Stage 0 (or Find's full extraction) flags as possibly scanned. */
export const isCandidatePage = (pt: Pick<PageText, 'items'>): boolean =>
  visibleChars(pt) < CANDIDATE_MAX_CHARS

/** The page indices Stage 0 reads: the first min(8, n), then the page in view if it is not one. */
export function stage0Pages(pageCount: number, inView: number | null = null): number[] {
  const n = Math.max(0, Math.floor(pageCount))
  const pages = Array.from({ length: Math.min(STAGE0_PAGES, n) }, (_, i) => i)
  if (inView !== null && Number.isInteger(inView) && inView >= STAGE0_PAGES && inView < n)
    pages.push(inView)
  return pages
}

export type Stage0Decision =
  /** PDFx made this source from an image: no triage; recognise it as a photo page (D4). */
  | { kind: 'image-origin' }
  /** Send the bytes for PDFium triage; `pages` are the candidates Stage 0 saw. */
  | { kind: 'candidate'; pages: number[] }
  /** Every page Stage 0 read has real text: do not spawn the OCR process for this source. */
  | { kind: 'not-candidate' }
  /** Some of the pages Stage 0 needs are not extracted yet. */
  | { kind: 'pending'; missing: number[] }

export interface Stage0Input {
  origin?: PdfSource['origin']
  pageCount: number
  /** The page in view (0-based), if any. */
  inView?: number | null
  /** Extracted text by page index (any subset; the decision says which are missing). */
  texts: ReadonlyMap<number, Pick<PageText, 'items'>>
}

/** The pure Stage 0 decision. */
export function stage0Decision(input: Stage0Input): Stage0Decision {
  if (input.origin === 'image') return { kind: 'image-origin' }
  const pages = stage0Pages(input.pageCount, input.inView ?? null)
  const missing = pages.filter((p) => !input.texts.has(p))
  const candidates = pages.filter((p) => {
    const t = input.texts.get(p)
    return t !== undefined && isCandidatePage(t)
  })
  // One candidate is enough to triage; waiting for the rest would only delay it.
  if (candidates.length > 0) return { kind: 'candidate', pages: candidates }
  if (missing.length > 0) return { kind: 'pending', missing }
  return { kind: 'not-candidate' }
}

export interface RunStage0Options {
  /** The extractor (default: the search engine's `extractPageText`). */
  extract?: (pdf: PdfSource['pdf'], pageIndex: number) => Promise<Pick<PageText, 'items'>>
  inView?: number | null
  /** Stop early (the source was closed). */
  signal?: AbortSignal
}

/**
 * Run Stage 0 for one source: extract the pages it needs one at a time (they share the single
 * pdf.js worker with thumbnails and Find) and stop at the first candidate. A page whose text
 * cannot be read counts as a candidate: an unreadable text layer is exactly what triage is for.
 */
export async function runStage0(
  source: Pick<PdfSource, 'pdf' | 'origin'>,
  opts: RunStage0Options = {}
): Promise<Stage0Decision> {
  if (source.origin === 'image') return { kind: 'image-origin' }
  const extract = opts.extract ?? extractPageText
  const pageCount = source.pdf.numPages
  const texts = new Map<number, Pick<PageText, 'items'>>()
  for (const p of stage0Pages(pageCount, opts.inView ?? null)) {
    if (opts.signal?.aborted) break
    let text: Pick<PageText, 'items'>
    try {
      text = await extract(source.pdf, p)
    } catch {
      text = { items: [] }
    }
    texts.set(p, text)
    if (isCandidatePage(text)) break
  }
  return stage0Decision({ origin: source.origin, pageCount, inView: opts.inView ?? null, texts })
}
