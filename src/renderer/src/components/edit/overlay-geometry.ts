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
