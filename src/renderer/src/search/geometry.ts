// Match geometry: a range of a page's normalized text → rectangles in "page px" — the display
// frame at scale 1 with a top-left origin, the same frame as PageEntry.width × PageEntry.height
// (intrinsic /Rotate applied, the user's edit rotation not).

import type { Geom } from '../edit/model'
import type { PageText, TextItemGeom } from './extract'

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
    // Proportional split of the run's advance: an approximation of per-glyph positions.
    const x0 = it.rtl ? it.width * (1 - hi / len) : (it.width * lo) / len
    const x1 = it.rtl ? it.width * (1 - lo / len) : (it.width * hi) / len
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
    const hi = pt.srcEnd[i] - base
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
