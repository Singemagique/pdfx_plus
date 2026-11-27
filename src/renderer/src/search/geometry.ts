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
const WIDE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\uff01-\uff60]/u

/** The estimated advance of one UTF-16 unit of an item's str (combining marks and low surrogates: 0). */
export function charWeight(str: string, i: number): number {
  const c = str.charCodeAt(i)
  if (c >= 0x20 && c <= 0x7e) return HELVETICA[c - 0x20]
  if (c < 0x20) return 0
  if (c >= 0xdc00 && c <= 0xdfff) return 0
  const cp = str.codePointAt(i)!
  const ch = String.fromCodePoint(cp)
  if (/\p{M}/u.test(ch)) return 0
  if (WIDE.test(ch)) return 1000
  // An accented Latin letter is as wide as its base letter ("é" as "e").
  const base = ch.normalize('NFD').charCodeAt(0)
  if (base >= 0x20 && base <= 0x7e) return HELVETICA[base - 0x20]
  return 556
}

/**
 * The fraction of the item's advance taken by its first `lo` and first `hi` UTF-16 units. An
 * even split for a monospaced font (exact there); otherwise the Helvetica-weighted estimate.
 */
function sliceFractions(it: TextItemGeom, lo: number, hi: number): [number, number] {
  const len = Math.max(1, it.str.length)
  if (it.mono) return [lo / len, hi / len]
  let total = 0
  let a = 0
  let b = 0
  for (let i = 0; i < it.str.length; i++) {
    if (i === lo) a = total
    if (i === hi) b = total
    total += charWeight(it.str, i)
  }
  if (lo >= it.str.length) a = total
  if (hi >= it.str.length) b = total
  return total > 0 ? [a / total, b / total] : [lo / len, hi / len]
}

/** A raw [lo, hi) slice of one item → its axis-aligned box in page px. */
function itemSliceRect(it: TextItemGeom, lo: number, hi: number, vt: readonly number[]): PageRect {
  const [a, b, c, d, e, f] = it.t
  const len = Math.max(1, it.str.length)
  const fh = Math.hypot(c, d) || it.height || 1
  const corners: Array<[number, number]> = []
  if (it.vertical) {
    // Vertical runs read top to bottom from the origin: split their length proportionally.
    const y0 = f - (it.height * lo) / len
    const y1 = f - (it.height * hi) / len
    corners.push([e, y0], [e + fh, y0], [e, y1], [e + fh, y1])
  } else {
    // A weighted split of the run's advance: an estimate of per-glyph positions.
    const [fa, fb] = sliceFractions(it, lo, hi)
    const x0 = it.rtl ? it.width * (1 - fb) : it.width * fa
    const x1 = it.rtl ? it.width * (1 - fa) : it.width * fb
    const angle = Math.atan2(b, a)
    const ax = Math.cos(angle)
    const ay = Math.sin(angle)
    // Text space is y-up: "up" is the baseline direction turned 90° counter-clockwise.
    const ux = -ay
    const uy = ax
    for (const x of [x0, x1]) {
      for (const v of [fh * it.descent, fh * it.ascent]) {
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
