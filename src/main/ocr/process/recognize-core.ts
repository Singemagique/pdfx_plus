// The recognize thread's per-page pipeline (DESIGN.md §3.4.5, §3.4.6), as pure functions over an
// engine, so vitest runs it with the real core (tier 1) or a fake one (tier 0).
//
// PR5 runs pass 1 only: PSM 3, Otsu, at the render DPI. PR6 adds preprocessing, orientation,
// deskew, the adaptive x-height pass and the retries (Sauvola; PSM 11); they plug in as more passes
// through `nextPass`, and the pass with the higher Σ(conf × chars) is kept (§3.4.5). The budget is
// at most 3 recognitions per page plus the adaptive re-render.

import type { RawOcr, GrayImage } from '../../../shared/ocr/engine/types'
import { TessError, fullPageParams, type TessParams } from '../../../shared/ocr/engine/tess-core'
import { hocrToRaw, parseHocr } from '../../../shared/ocr/hocr'

/**
 * The name and message a recognize thread posts for a failed page (`{ type: 'error' }`), for the
 * coordinator's failure policy (`isOomShaped`); never page content. A WASM OOM (TessError kind
 * 'oom') becomes `OcrOutOfMemory`, which the coordinator treats as OOM-shaped (respawn, re-queue
 * once, halve n); an abort is a `RuntimeError`; every other kind stays a `TessError`.
 */
export function describeRecognizeError(e: unknown): { name: string; message: string } {
  if (e instanceof TessError) {
    if (e.kind === 'oom') return { name: 'OcrOutOfMemory', message: `out of memory: ${e.message}` }
    return { name: e.kind === 'abort' ? 'RuntimeError' : 'TessError', message: e.message }
  }
  const err = e instanceof Error ? e : new Error('non-Error throw')
  return { name: err.name, message: err.message.slice(0, 300) }
}

export interface RecognizeEngine {
  recognize(img: GrayImage, params: TessParams): { hocr: string }
}

export interface PassPlan {
  /** 'pass1' now; PR6: 'sauvola', 'sparse', 'adaptive'. */
  id: string
  params: TessParams
}

export interface PassSummary {
  id: string
  ms: number
  words: number
  /** Σ(conf × chars) over words with a confidence (§3.4.5's keep-the-better rule). */
  score: number
}

export interface RecognizeOutcome {
  raw: RawOcr
  /** The id of the pass whose result is `raw`. */
  chosen: string
  passes: PassSummary[]
  /** Each pass's hOCR, only when asked for (the tier-1 replay recorder). */
  hocr?: string[]
}

/** At most this many recognitions per page (§3.4.5), whatever later passes decide. */
export const MAX_PASSES = 3

/** Σ(conf × chars): the score by which two passes over one page are compared. */
export function passScore(raw: RawOcr): number {
  let s = 0
  for (const l of raw.lines)
    for (const w of l.words) if (w.conf !== null && w.conf > 0) s += w.conf * [...w.text].length
  return s
}

const wordCount = (raw: RawOcr): number => raw.lines.reduce((n, l) => n + l.words.length, 0)

/** The first pass for a page rendered at `dpi`. */
export function firstPass(dpi: number): PassPlan {
  return { id: 'pass1', params: fullPageParams(dpi) }
}

/**
 * What to run after the passes so far, or null to stop. PR5: always stop after pass 1. PR6 adds
 * the retry gates here (calibrated mean below the retry threshold → Sauvola; OCR chars < 30% of
 * the connected components → PSM 11).
 */
export function nextPass(done: readonly PassSummary[], _dpi: number): PassPlan | null {
  void done
  return null
}

/** Recognise one page: run the pass plan, parse each hOCR, keep the best-scoring pass. */
export function recognizePage(
  engine: RecognizeEngine,
  img: GrayImage,
  dpi: number,
  opts: { returnHocr?: boolean; now?: () => number } = {}
): RecognizeOutcome {
  const now = opts.now ?? (() => performance.now())
  const hocrs: string[] = []
  const passes: PassSummary[] = []
  let best: { raw: RawOcr; id: string; score: number } | null = null
  let plan: PassPlan | null = firstPass(dpi)
  while (plan && passes.length < MAX_PASSES) {
    const t0 = now()
    const { hocr } = engine.recognize(img, plan.params)
    if (opts.returnHocr) hocrs.push(hocr)
    const raw = hocrToRaw(parseHocr(hocr))
    const score = passScore(raw)
    passes.push({ id: plan.id, ms: Math.round(now() - t0), words: wordCount(raw), score })
    if (!best || score > best.score) best = { raw, id: plan.id, score }
    plan = nextPass(passes, dpi)
  }
  if (!best) throw new Error('no recognition pass ran')
  const out: RecognizeOutcome = { raw: best.raw, chosen: best.id, passes }
  if (opts.returnHocr) out.hocr = hocrs
  return out
}
