// Coordinate conversion between the overlay model (PDF user space, origin bottom-left,
// units = points) and the on-screen overlay layer, which lives inside `.full-page` — a
// box sized to the page's fit rect (CSS px). Because the overlay layer is a child of
// `.full-page`, it inherits the same zoom transform as the pdf.js canvas, so model→CSS
// uses the unscaled fit ratio; pointer→model uses the element's live bounding rect, which
// already reflects any zoom.

import type { Geom } from '../../edit/model'

export interface PageBox {
  width: number
  height: number
}
export interface FitSize {
  w: number
  h: number
}
export interface CssRect {
  left: number
  top: number
  width: number
  height: number
}
export interface Pt {
  x: number
  y: number
}

/** CSS px per PDF point (uniform — fitInto preserves aspect ratio). */
export const pageScale = (page: PageBox, fit: FitSize): number => fit.w / page.width

/** Overlay geom (PDF, bottom-left) → CSS rect inside the fit-sized page box (top-left). */
export function geomToCss(geom: Geom, page: PageBox, fit: FitSize): CssRect {
  const s = pageScale(page, fit)
  return {
    left: geom.x * s,
    top: (page.height - geom.y - geom.h) * s,
    width: geom.w * s,
    height: geom.h * s
  }
}

/** A single PDF point (bottom-left origin) → CSS point inside the page box (top-left). */
export function pointToCss(x: number, y: number, page: PageBox, fit: FitSize): Pt {
  const s = pageScale(page, fit)
  return { x: x * s, y: (page.height - y) * s }
}

/** A client (screen) point + the overlay element's on-screen rect → PDF point (bottom-left). */
export function clientToPdf(clientX: number, clientY: number, rect: CssRect, page: PageBox): Pt {
  const fx = (clientX - rect.left) / rect.width
  const fy = (clientY - rect.top) / rect.height
  return { x: fx * page.width, y: (1 - fy) * page.height }
}

/**
 * Client point → natural PDF point when the page box (upright CSS size `box`) is rendered
 * CSS-rotated by `rot` degrees CW and uniformly zoom-scaled. `bbox` is the layer's on-screen
 * axis-aligned rect. Inverts rotation+scale about the box centre, then maps to page points.
 */
export function clientToPdfRotated(
  clientX: number,
  clientY: number,
  bbox: CssRect,
  box: FitSize,
  page: PageBox,
  rot: number
): Pt {
  const r = ((rot % 360) + 360) % 360
  if (r === 0) return clientToPdf(clientX, clientY, bbox, page)
  const swapped = r === 90 || r === 270
  const s = bbox.width / (swapped ? box.h : box.w) // zoom scale extracted from the bbox
  const cx = bbox.left + bbox.width / 2
  const cy = bbox.top + bbox.height / 2
  const vx = clientX - cx
  const vy = clientY - cy
  const a = (r * Math.PI) / 180
  const lx = (vx * Math.cos(a) + vy * Math.sin(a)) / s + box.w / 2
  const ly = (-vx * Math.sin(a) + vy * Math.cos(a)) / s + box.h / 2
  return { x: (lx / box.w) * page.width, y: (1 - ly / box.h) * page.height }
}

/**
 * Map a rectangle from a page's UNROTATED user space (e.g. a pdf.js annotation `/Rect`) into the
 * rotation-baked "visual" space the overlay model lives in, given the visual page dims (`vw`,`vh`)
 * and the page's intrinsic `/Rotate`. This is the inverse of the export-side unrotateCrop /
 * intrinsicMatrix, so a form-field geom built from an annotation rect lines up with geomToCss in
 * the editor and with the flatten rotation transform on export. A no-op for unrotated pages.
 */
export function rectToVisual(
  g: { x: number; y: number; w: number; h: number },
  rotate: number,
  vw: number,
  vh: number
): { x: number; y: number; w: number; h: number } {
  const wu = rotate === 90 || rotate === 270 ? vh : vw // unrotated width
  const hu = rotate === 90 || rotate === 270 ? vw : vh // unrotated height
  switch (((rotate % 360) + 360) % 360) {
    case 90:
      return { x: g.y, y: wu - g.x - g.w, w: g.h, h: g.w }
    case 180:
      return { x: wu - g.x - g.w, y: hu - g.y - g.h, w: g.w, h: g.h }
    case 270:
      return { x: hu - g.y - g.h, y: g.x, w: g.h, h: g.w }
    default:
      return { x: g.x, y: g.y, w: g.w, h: g.h }
  }
}

/** Normalized geom (PDF) spanning two corner points — used for drag-rectangle tools. */
export function rectGeom(a: Pt, b: Pt, opacity = 1): Geom {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
    rotation: 0,
    opacity
  }
}

/** CSS-corner identifiers for the four resize handles. */
export type HandleId = 'tl' | 'tr' | 'bl' | 'br'

// The PDF point of the corner OPPOSITE a CSS-corner handle — it stays fixed while
// dragging. CSS top = PDF y+h, CSS bottom = PDF y; CSS left = PDF x, right = x+w.
function oppositeCorner(g: Geom, handle: HandleId): Pt {
  switch (handle) {
    case 'tl':
      return { x: g.x + g.w, y: g.y }
    case 'tr':
      return { x: g.x, y: g.y }
    case 'bl':
      return { x: g.x + g.w, y: g.y + g.h }
    case 'br':
      return { x: g.x, y: g.y + g.h }
  }
}

/** New geom when a resize handle is dragged to PDF point `p` (opposite corner fixed). */
export function resizeGeom(start: Geom, handle: HandleId, p: Pt): Geom {
  const g = rectGeom(oppositeCorner(start, handle), p, start.opacity)
  g.rotation = start.rotation
  return g
}

/** Translate a flat [x0,y0,…] point list by (dx, dy) in PDF space. */
export function movePath(path: number[], dx: number, dy: number): number[] {
  return path.map((v, i) => (i % 2 === 0 ? v + dx : v + dy))
}

/** Rescale a point list as its bounding box goes from `from` to `to`. */
export function scalePath(path: number[], from: Geom, to: Geom): number[] {
  const sx = from.w === 0 ? 1 : to.w / from.w
  const sy = from.h === 0 ? 1 : to.h / from.h
  return path.map((v, i) => (i % 2 === 0 ? to.x + (v - from.x) * sx : to.y + (v - from.y) * sy))
}

/** Bounding geom (PDF) of a flat [x0,y0,x1,y1,…] point list — used as an ink stroke's box. */
export function boundsOfPath(path: number[], opacity = 1): Geom {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let i = 0; i + 1 < path.length; i += 2) {
    minX = Math.min(minX, path[i])
    maxX = Math.max(maxX, path[i])
    minY = Math.min(minY, path[i + 1])
    maxY = Math.max(maxY, path[i + 1])
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0, rotation: 0, opacity }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY, rotation: 0, opacity }
}
