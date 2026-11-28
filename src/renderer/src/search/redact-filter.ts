// Redaction-aware page text (DESIGN.md §3.6.1, §3.7.3 rule 3): the items Find, Copy Page Text and
// the recognised-text overlay read once the user has boxed some of a page out. Pure: the stored
// extraction is never touched, so removing the box brings the text back.
//
// - pdf.js (native) items lose the CHARACTERS whose padded slice box touches a redaction, and are
//   split around them, so the rest of a long pdf.js line stays searchable. pdf.js gives one
//   advance per (often line-long, merged) item, so where a character lies inside it is only
//   estimated, and a redaction must not trust any one estimate: a character's box is the UNION of
//   where the Helvetica-weighted, the Times-weighted and the even split put it (geometry.ts
//   `sliceSpanBounds`; exact charEdges alone when the item has them), padded by
//   max(1 pt, 0.15 × size) all round, plus — when not exact — half an average character width
//   and 1 % of the distance to the item's nearer end along the run (both ends of an item are
//   exact; an estimate drifts towards the middle). Every error goes towards removing too much. An
//   item that cannot be sliced (no advance) is dropped whole when its estimated box touches one.
// - OCR items (`ocr: true`) are dropped WHOLE when their word footprint touches a redaction: the
//   em box (ascent 0.8, descent −0.2) about the baseline, rotated with the line, its bounding box
//   padded by max(1 pt, 0.15 × size) (types.ts `wordFootprint`, in page px).
//
// What was removed becomes a single ' ' item in its place, carrying the removed run's line break,
// so a redaction is also a word boundary: the words either side never join into one, and a line
// ending under the box still ends.

import type { PageTextItem, TextItemGeom } from './extract'
import {
  charWeight,
  itemFontSize,
  itemSliceRect,
  itemSpanRect,
  sliceItem,
  sliceSpanBounds,
  type PageRect
} from './geometry'
import { clusterEnd } from './normalize'

/** Along-run margin of an estimated character box: this many average character widths… */
const AVG_PAD = 0.5
/** …plus this fraction of the distance from the box to the item's nearer end. */
const DRIFT_PAD = 0.01

/** max(1 pt, 0.15 × size): the footprint pad of the OCR layer (types.ts `footprintPad`). */
export const redactionPad = (size: number): number => Math.max(1, 0.15 * size)

/** A rect with a non-negative size (a redaction drawn right-to-left has a negative w or h). */
export function normalizeRect(r: PageRect): PageRect {
  const x = Math.min(r.x, r.x + r.w)
  const y = Math.min(r.y, r.y + r.h)
  return { x, y, w: Math.abs(r.w), h: Math.abs(r.h) }
}

/** Strict overlap of two page-px rects (touching edges do not count, as mirror.ts). */
const overlaps = (p: PageRect, q: PageRect): boolean =>
  p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h

const hitsAny = (r: PageRect, rects: readonly PageRect[]): boolean =>
  rects.some((q) => overlaps(r, q))

const isBlank = (s: string): boolean => s.trim().length === 0

/** The item's run is long enough to place a slice (an advance, or a height when vertical). */
const sliceable = (it: TextItemGeom): boolean =>
  it.vertical
    ? it.height > 0 && Number.isFinite(it.height)
    : it.width > 0 && Number.isFinite(it.width)

/** The ' ' item that stands in for a removed run: same place, no text, its line break kept. */
function gap(geom: TextItemGeom, hasEOL: boolean): PageTextItem {
  const out: PageTextItem = { ...geom, str: ' ', hasEOL }
  delete out.charEdges
  return out
}

/** One OCR word: kept, or replaced by a gap when its padded footprint touches a redaction. */
function filterOcrItem(
  it: PageTextItem,
  rects: readonly PageRect[],
  vt: readonly number[]
): PageTextItem[] {
  if (isBlank(it.str)) return [it]
  const p = redactionPad(itemFontSize(it))
  const box = sliceable(it)
    ? itemSliceRect(it, 0, it.str.length, vt, { along: p, across: p })
    : unsliceableBox(it, vt, p)
  return hitsAny(box, rects) ? [gap(it, it.hasEOL)] : [it]
}

/**
 * A fail-safe box for an item with no usable advance: its Helvetica-estimated length (at least one
 * em), padded along the run by that length again.
 */
function unsliceableBox(it: TextItemGeom, vt: readonly number[], pad: number): PageRect {
  const fh = itemFontSize(it)
  let units = 0
  for (let i = 0; i < it.str.length; i++) units += charWeight(it.str, i)
  const est = Math.max(fh, (units / 1000) * fh)
  const probe: TextItemGeom = it.vertical ? { ...it, height: est } : { ...it, width: est }
  delete probe.charEdges
  return itemSliceRect(probe, 0, it.str.length, vt, { along: pad + est, across: pad })
}

/** A raw [lo, hi) run of an item's str, removed by a redaction or kept. */
export interface CharRun {
  lo: number
  hi: number
  removed: boolean
}

/**
 * How a pdf.js item splits under `rects` (normalized page-px boxes): its runs in order, or null
 * when no redaction touches it.
 */
export function nativeRuns(
  it: TextItemGeom,
  rects: readonly PageRect[],
  vt: readonly number[]
): CharRun[] | null {
  if (isBlank(it.str)) return null
  const fh = itemFontSize(it)
  const pad = redactionPad(fh)
  if (!sliceable(it))
    return hitsAny(unsliceableBox(it, vt, pad), rects)
      ? [{ lo: 0, hi: it.str.length, removed: true }]
      : null
  const runLen = it.vertical ? it.height : it.width
  const avg = runLen / Math.max(1, [...it.str].length)
  // The whole run, padded at least as far as any character box below reaches past its ends.
  if (!hitsAny(itemSpanRect(it, 0, runLen, vt, { along: pad + avg, across: pad }), rects))
    return null
  const clusterBox = (i: number, j: number): PageRect => {
    const { s0, s1, exact } = sliceSpanBounds(it, i, j)
    const drift = DRIFT_PAD * Math.max(0, Math.min(s0, runLen - s1))
    const along = exact ? pad : pad + AVG_PAD * avg + drift
    return itemSpanRect(it, s0, s1, vt, { along, across: pad })
  }
  // Per cluster: removed or kept. Whitespace carries nothing, so it joins the run before it.
  const runs: CharRun[] = []
  for (let i = 0; i < it.str.length; ) {
    const j = clusterEnd(it.str, i)
    const last = runs[runs.length - 1]
    const removed = isBlank(it.str.slice(i, j))
      ? (last?.removed ?? false)
      : hitsAny(clusterBox(i, j), rects)
    if (last && last.removed === removed) last.hi = j
    else runs.push({ lo: i, hi: j, removed })
    i = j
  }
  return runs.length === 1 && !runs[0].removed ? null : runs
}

/** One pdf.js item: split around the characters a redaction touches. */
function filterNativeItem(
  it: PageTextItem,
  rects: readonly PageRect[],
  vt: readonly number[]
): PageTextItem[] {
  const runs = nativeRuns(it, rects, vt)
  if (!runs) return [it]
  if (runs.length === 1) return [gap(it, it.hasEOL)]
  return runs.map(({ lo, hi, removed }, k) => {
    const eol = k === runs.length - 1 && it.hasEOL
    const piece = sliceItem(it, lo, hi)
    return removed ? gap(piece, eol) : { ...piece, hasEOL: eol }
  })
}

/**
 * `items` with everything under `rects` (page px, the frame `textMatchRects` returns) removed, for
 * a page whose pdf.js viewport transform is `vt`. Returns `items` itself when nothing is touched.
 */
export function filterRedacted(
  items: readonly PageTextItem[],
  rects: readonly PageRect[] | null | undefined,
  vt: readonly number[]
): readonly PageTextItem[] {
  if (!rects || rects.length === 0) return items
  const boxes = rects.map(normalizeRect).filter((r) => r.w > 0 && r.h > 0)
  if (boxes.length === 0) return items
  let changed = false
  const out: PageTextItem[] = []
  for (const it of items) {
    const kept = it.ocr ? filterOcrItem(it, boxes, vt) : filterNativeItem(it, boxes, vt)
    if (kept.length !== 1 || kept[0] !== it) changed = true
    out.push(...kept)
  }
  return changed ? out : items
}
