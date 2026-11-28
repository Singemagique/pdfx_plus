// Match geometry: a range of a page's normalized text → rectangles in "page px" — the display
// frame at scale 1 with a top-left origin, the same frame as PageEntry.width × PageEntry.height
// (intrinsic /Rotate applied, the user's edit rotation not).

import type { Geom } from '../edit/model'
import type { PageText, TextItemGeom } from './extract'
import { clusterEnd } from './normalize'

export interface PageRect {
  x: number
  y: number
  w: number
  h: number
}

/** The item holding global raw offset `g` (the last item starting at or before it). */
function itemAt(starts: Int32Array, g: number): number {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid] <= g) lo = mid
    else hi = mid - 1
  }
  return lo
}

/**
 * Helvetica advance widths (1/1000 em) for U+0020–U+007E, from the standard-14 font metrics. pdf.js
 * reports one advance per text item, not per glyph, so a slice of an item is placed by weighting its
 * characters with these: most body text is set in a proportional sans or serif whose widths track
 * Helvetica's far better than an even split does (a space or an "i" is a quarter of an "m").
 */
const HELVETICA = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667,
  611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
  667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500,
  222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584
]
/**
 * Times-Roman advance widths (1/1000 em) for U+0020–U+007E (standard-14 metrics): the serif
 * counterpart, which a redaction's slice bounds use alongside Helvetica's (sliceSpanBounds).
 */
const TIMES = [
  250, 333, 408, 500, 500, 833, 778, 180, 333, 333, 500, 564, 250, 333, 250, 278, 500, 500, 500,
  500, 500, 500, 500, 500, 500, 500, 278, 278, 564, 564, 564, 444, 921, 722, 667, 667, 722, 611,
  556, 722, 722, 333, 389, 722, 611, 889, 722, 722, 556, 722, 667, 556, 611, 722, 722, 944, 722,
  722, 611, 333, 278, 333, 469, 500, 333, 444, 500, 444, 500, 444, 333, 500, 500, 278, 278, 500,
  278, 778, 500, 500, 500, 500, 333, 389, 278, 500, 500, 722, 500, 500, 444, 480, 200, 480, 541
]
const WIDE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\uff01-\uff60]/u

/** The estimated advance of one UTF-16 unit of an item's str (combining marks and low surrogates: 0). */
export function charWeight(str: string, i: number, table: readonly number[] = HELVETICA): number {
  const c = str.charCodeAt(i)
  if (c >= 0x20 && c <= 0x7e) return table[c - 0x20]
  if (c < 0x20) return 0
  if (c >= 0xdc00 && c <= 0xdfff) return 0
  const cp = str.codePointAt(i)!
  const ch = String.fromCodePoint(cp)
  if (/\p{M}/u.test(ch)) return 0
  if (WIDE.test(ch)) return 1000
  // An accented Latin letter is as wide as its base letter ("é" as "e").
  const base = ch.normalize('NFD').charCodeAt(0)
  if (base >= 0x20 && base <= 0x7e) return table[base - 0x20]
  return table[0x6e - 0x20] // as wide as an "n"
}

/**
 * The item's exact edges (`charEdges`) at UTF-16 offsets `lo` and `hi`, as fractions of its
 * advance, or null when it has none or they don't fit its text (one edge per code point, plus
 * one, rising from 0 to the advance).
 */
function edgeFractions(it: TextItemGeom, lo: number, hi: number): [number, number] | null {
  const edges = it.charEdges
  if (!edges || !(it.width > 0)) return null
  let cps = 0
  let a = -1
  let b = -1
  for (let i = 0; i <= it.str.length; ) {
    if (i === lo) a = cps
    if (i === hi) b = cps
    if (i === it.str.length) break
    i += it.str.codePointAt(i)! > 0xffff ? 2 : 1
    cps++
  }
  if (edges.length !== cps + 1 || a < 0 || b < 0) return null
  const total = edges[cps]
  if (!(total > 0)) return null
  return [edges[a] / total, edges[b] / total]
}

/**
 * The fraction of the item's advance taken by its first `lo` and first `hi` UTF-16 units. Exact
 * from `charEdges` (OCR words) or for a monospaced font (an even split); otherwise the
 * Helvetica-weighted estimate.
 */
function sliceFractions(it: TextItemGeom, lo: number, hi: number): [number, number] {
  const len = Math.max(1, it.str.length)
  const exact = !it.vertical && edgeFractions(it, lo, hi)
  if (exact) return exact
  if (it.mono) return [lo / len, hi / len]
  return weightedFractions(it, lo, hi)
}

/** The fractions of [lo, hi) weighted by `table` (an even split when nothing has a weight). */
function weightedFractions(
  it: TextItemGeom,
  lo: number,
  hi: number,
  table: readonly number[] = HELVETICA
): [number, number] {
  const len = Math.max(1, it.str.length)
  let total = 0
  let a = 0
  let b = 0
  for (let i = 0; i < it.str.length; i++) {
    if (i === lo) a = total
    if (i === hi) b = total
    total += charWeight(it.str, i, table)
  }
  if (lo >= it.str.length) a = total
  if (hi >= it.str.length) b = total
  return total > 0 ? [a / total, b / total] : [lo / len, hi / len]
}

/** The font size of an item: the length of its transform's "up" vector. */
export const itemFontSize = (it: TextItemGeom): number =>
  Math.hypot(it.t[2], it.t[3]) || it.height || 1

/** Where a raw [lo, hi) slice of an item lies along its run, in user units from its origin. */
function sliceSpan(it: TextItemGeom, lo: number, hi: number): [number, number] {
  if (it.vertical) {
    const len = Math.max(1, it.str.length)
    return [(it.height * lo) / len, (it.height * hi) / len]
  }
  // A weighted split of the run's advance: an estimate of per-glyph positions (exact with
  // charEdges or a monospaced font).
  const [fa, fb] = sliceFractions(it, lo, hi)
  return it.rtl ? [it.width * (1 - fb), it.width * (1 - fa)] : [it.width * fa, it.width * fb]
}

/**
 * Where a raw [lo, hi) slice of an item MAY lie along its run (user units from its origin): the
 * union of every estimate — the item's exact charEdges alone when it has them (`exact`), else the
 * Helvetica-weighted, the Times-weighted and the even split together (a sans, a serif and a
 * monospaced font; the weights are fractions of the run, so a condensed or expanded cut of one
 * is covered too). `mono` is not trusted here: pdf.js flags a font monospaced from its widths
 * alone, and PDFx's own glyphless OCR font (every width 500, each word stretched by its own Tz) is
 * flagged so although its words are anything but evenly spaced across a merged line. Vertical
 * runs are split evenly. A redaction uses this, never the single best estimate.
 */
export function sliceSpanBounds(
  it: TextItemGeom,
  lo: number,
  hi: number
): { s0: number; s1: number; exact: boolean } {
  const len = Math.max(1, it.str.length)
  const even: [number, number] = [lo / len, hi / len]
  if (it.vertical) return { s0: (it.height * lo) / len, s1: (it.height * hi) / len, exact: false }
  const exact = edgeFractions(it, lo, hi)
  const candidates = exact
    ? [exact]
    : [weightedFractions(it, lo, hi), weightedFractions(it, lo, hi, TIMES), even]
  let s0 = Infinity
  let s1 = -Infinity
  for (const [fa, fb] of candidates) {
    const [p, q] = it.rtl
      ? [it.width * (1 - fb), it.width * (1 - fa)]
      : [it.width * fa, it.width * fb]
    s0 = Math.min(s0, p)
    s1 = Math.max(s1, q)
  }
  return { s0, s1, exact: !!exact }
}

/** Extra margin around a slice box, in user units: along the run and across it. */
export interface SlicePad {
  along: number
  across: number
}

/**
 * A raw [lo, hi) slice of one item → its axis-aligned box in page px, optionally grown by `pad`
 * on every side (along the run before rotating, so the pad follows a tilted baseline).
 */
export function itemSliceRect(
  it: TextItemGeom,
  lo: number,
  hi: number,
  vt: readonly number[],
  pad: SlicePad = { along: 0, across: 0 }
): PageRect {
  const [s0, s1] = sliceSpan(it, lo, hi)
  return itemSpanRect(it, s0, s1, vt, pad)
}

/**
 * The stretch [s0, s1] of an item's run (user units from its origin along the run) → its
 * axis-aligned box in page px, grown by `pad` as itemSliceRect.
 */
export function itemSpanRect(
  it: TextItemGeom,
  s0: number,
  s1: number,
  vt: readonly number[],
  pad: SlicePad = { along: 0, across: 0 }
): PageRect {
  const [a, b, , , e, f] = it.t
  const fh = itemFontSize(it)
  const corners: Array<[number, number]> = []
  if (it.vertical) {
    // Vertical runs read top to bottom from the origin: split their length proportionally.
    const y0 = f - s0 + pad.along
    const y1 = f - s1 - pad.along
    for (const x of [e - pad.across, e + fh + pad.across]) corners.push([x, y0], [x, y1])
  } else {
    const angle = Math.atan2(b, a)
    const ax = Math.cos(angle)
    const ay = Math.sin(angle)
    // Text space is y-up: "up" is the baseline direction turned 90° counter-clockwise.
    const ux = -ay
    const uy = ax
    for (const x of [s0 - pad.along, s1 + pad.along]) {
      for (const v of [fh * it.descent - pad.across, fh * it.ascent + pad.across]) {
        corners.push([e + ax * x + ux * v, f + ay * x + uy * v])
      }
    }
  }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [x, y] of corners) {
    const X = vt[0] * x + vt[2] * y + vt[4]
    const Y = vt[1] * x + vt[3] * y + vt[5]
    minX = Math.min(minX, X)
    maxX = Math.max(maxX, X)
    minY = Math.min(minY, Y)
    maxY = Math.max(maxY, Y)
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

/**
 * The raw [lo, hi) slice of an item as an item of its own: its text, and its origin and advance
 * moved to where the slice lies along the run (the same estimate the highlight boxes use).
 * `hasEOL` is the caller's to set; `charEdges` are sliced along when the item has exact ones.
 */
export function sliceItem(it: TextItemGeom, lo: number, hi: number): TextItemGeom {
  const [s0, s1] = sliceSpan(it, lo, hi)
  const [a, b, c, d, e, f] = it.t
  const out: TextItemGeom = { ...it, str: it.str.slice(lo, hi), hasEOL: false }
  delete out.charEdges
  if (it.vertical) {
    out.t = [a, b, c, d, e, f - s0]
    out.height = s1 - s0
    return out
  }
  const angle = Math.atan2(b, a)
  out.t = [a, b, c, d, e + Math.cos(angle) * s0, f + Math.sin(angle) * s0]
  out.width = s1 - s0
  if (it.charEdges && !it.rtl && edgeFractions(it, lo, hi)) {
    // Code-point indices of lo and hi, then the edges between them rebased to 0.
    const cpLo = [...it.str.slice(0, lo)].length
    const cpHi = cpLo + [...out.str].length
    const base = it.charEdges[cpLo]
    const edges: number[] = []
    for (let i = cpLo; i <= cpHi; i++) edges.push(it.charEdges[i] - base)
    out.charEdges = edges
  }
  return out
}

/**
 * Merge neighbouring rects on the same line (vertical overlap at least half the smaller height,
 * horizontal gap at most 0.6 × the taller height) — one rect per line for a multi-item match.
 */
export function mergeLineRects(rects: readonly PageRect[]): PageRect[] {
  const out: PageRect[] = []
  for (const r of rects) {
    const last = out[out.length - 1]
    if (last) {
      const overlap = Math.min(last.y + last.h, r.y + r.h) - Math.max(last.y, r.y)
      const gap = Math.max(last.x, r.x) - Math.min(last.x + last.w, r.x + r.w)
      if (overlap >= 0.5 * Math.min(last.h, r.h) && gap <= 0.6 * Math.max(last.h, r.h)) {
        const x = Math.min(last.x, r.x)
        const y = Math.min(last.y, r.y)
        last.w = Math.max(last.x + last.w, r.x + r.w) - x
        last.h = Math.max(last.y + last.h, r.y + r.h) - y
        last.x = x
        last.y = y
        continue
      }
    }
    out.push({ ...r })
  }
  return out
}

/** The page-px rects covering normalized range [ns, ne) of `pt`. */
export function textMatchRects(pt: PageText, ns: number, ne: number): PageRect[] {
  if (pt.items.length === 0) return []
  // Per item, the raw [lo, hi) the range covers (contiguous within an item), in reading order.
  const spans = new Map<number, { lo: number; hi: number }>()
  for (let i = Math.max(0, ns); i < Math.min(ne, pt.srcStart.length); i++) {
    const s = pt.srcStart[i]
    if (s < 0) continue
    const k = itemAt(pt.itemStarts, s)
    const base = pt.itemStarts[k]
    const lo = s - base
    const hi = clusterEnd(pt.items[k]?.str ?? '', lo)
    const span = spans.get(k)
    if (span) {
      span.lo = Math.min(span.lo, lo)
      span.hi = Math.max(span.hi, hi)
    } else spans.set(k, { lo, hi })
  }
  const rects: PageRect[] = []
  for (const [k, { lo, hi }] of spans) {
    const it = pt.items[k]
    if (it) rects.push(itemSliceRect(it, lo, hi, pt.vt))
  }
  return mergeLineRects(rects)
}

/**
 * An overlay's box in page px. Overlay geoms live in the rotation-baked visual frame PageEntry's
 * dims describe (PDF points, bottom-left origin), so this is geomToCss at scale 1.
 */
export function overlayRect(geom: Geom, pageHeight: number): PageRect {
  return { x: geom.x, y: pageHeight - geom.y - geom.h, w: geom.w, h: geom.h }
}
