/**
 * Pure geometry for the PageView "detail" canvas: the sharp, viewport-sized overlay rendered on
 * top of the fixed-resolution base raster once a page is displayed larger than that raster.
 *
 * The page box (`.pageview`) is always laid out UPRIGHT (unrotated page aspect). Rotated pages
 * get a CSS `rotate()` on an ancestor, so the box's `getBoundingClientRect()` is the axis-aligned
 * box of the ROTATED page: for 90/270 its width is the upright page's height. Everything here is
 * therefore computed in the box's own upright coordinate space — the screen rect is un-rotated
 * first, and the visible screen region is mapped back through the rotation — so the detail
 * canvas (a child of the upright box) is rendered at the right scale and lands on the region
 * that is actually on screen.
 */

/** Base raster's long side in device pixels (fixed, independent of zoom/DPR). */
export const BASE_RASTER = 1100
/** Max device-pixel ratio honoured by the detail canvas (DPR-3 displays render at full DPR). */
export const MAX_DETAIL_DPR = 3
/** Max backing-store side of the detail canvas, in device pixels. */
export const MAX_DETAIL = 8192
/** Max total backing-store pixels of the detail canvas (32 MP ≈ 128 MB RGBA). */
export const MAX_DETAIL_PIXELS = 32 * 1024 * 1024

/** The DPR the detail canvas renders at: the display's, capped at {@link MAX_DETAIL_DPR}. */
export function detailDpr(raw: number): number {
  return Math.min(raw > 0 ? raw : 1, MAX_DETAIL_DPR)
}

/**
 * Downscale factor (≤ 1) that keeps a `w × h` device-pixel backing store within both the per-side
 * cap ({@link MAX_DETAIL}) and the total-pixel budget ({@link MAX_DETAIL_PIXELS}).
 */
export function detailCapFactor(w: number, h: number): number {
  if (!(w > 0) || !(h > 0)) return 1
  return Math.min(1, MAX_DETAIL / w, MAX_DETAIL / h, Math.sqrt(MAX_DETAIL_PIXELS / (w * h)))
}

export interface ScreenRect {
  left: number
  top: number
  width: number
  height: number
}

export interface DetailInput {
  /** `getBoundingClientRect()` of the upright page box (axis-aligned box of the rotated page). */
  rect: ScreenRect
  /** The page box's layout (untransformed) width — `offsetWidth`. */
  layoutW: number
  /** CSS rotation applied to the page box by an ancestor, in degrees (multiple of 90). */
  rotation: number
  /** The visible window, in CSS px. */
  viewportW: number
  viewportH: number
  /** Upright page size in PDF points. */
  naturalWidth: number
  naturalHeight: number
  /** Device-pixel ratio to render at (already capped, see {@link detailDpr}). */
  dpr: number
}

export interface DetailPlan {
  /** pdf.js viewport scale for the whole (upright) page. */
  renderScale: number
  /** Top-left of the visible region as a fraction of the upright page's width / height. */
  fx: number
  fy: number
  /** Detail canvas backing-store size, in device px. */
  backingW: number
  backingH: number
  /** Detail canvas placement inside the upright page box, in layout (CSS) px. */
  css: { left: number; top: number; width: number; height: number }
}

/** Normalise any rotation to 0 / 90 / 180 / 270. */
export function normalizeRotation(rotation: number): 0 | 90 | 180 | 270 {
  const r = ((Math.round(rotation / 90) * 90) % 360) + 360
  return (r % 360) as 0 | 90 | 180 | 270
}

/**
 * Plan the detail render, or `null` when none is needed (page off screen, or not displayed
 * larger than the base raster already covers).
 */
export function planDetail(input: DetailInput): DetailPlan | null {
  const { rect, layoutW, viewportW, viewportH, naturalWidth, naturalHeight, dpr: d } = input
  const rot = normalizeRotation(input.rotation)
  const quarter = rot === 90 || rot === 270

  // Upright page size on screen (screen px). For a quarter turn the bounding box is transposed.
  const uw = quarter ? rect.height : rect.width
  const uh = quarter ? rect.width : rect.height

  // Visible part of the bounding box, relative to its top-left (screen axes).
  const x0 = Math.max(0, rect.left) - rect.left
  const y0 = Math.max(0, rect.top) - rect.top
  const x1 = Math.min(viewportW, rect.left + rect.width) - rect.left
  const y1 = Math.min(viewportH, rect.top + rect.height) - rect.top
  if (x1 - x0 <= 0 || y1 - y0 <= 0) return null

  const baseDevicePx = (BASE_RASTER / Math.max(naturalWidth, naturalHeight)) * naturalWidth
  if (uw * d <= baseDevicePx * 1.05) return null

  const { u0, v0, visW, visH } = unrotateRegion(rot, uw, uh, x0, y0, x1, y1)

  const cap = detailCapFactor(visW * d, visH * d)
  // Uncapped: round to the nearest device pixel. Capped: floor, so the budget is never exceeded.
  const snap = cap < 1 ? Math.floor : Math.round
  const s = uw / layoutW
  const eff = Number.isFinite(s) && s > 0 ? s : 1
  return {
    renderScale: (uw / naturalWidth) * d * cap,
    fx: u0 / uw,
    fy: v0 / uh,
    backingW: Math.max(1, snap(visW * d * cap)),
    backingH: Math.max(1, snap(visH * d * cap)),
    css: { left: u0 / eff, top: v0 / eff, width: visW / eff, height: visH / eff }
  }
}

/**
 * Map a region of the rotated page's bounding box (screen axes, relative to its top-left) back
 * into the upright box (same screen scale). CSS rotate() turns clockwise with y pointing down, so
 * the upright point (u, v) of a `uw × uh` box lands in the bounding box at
 *   90: (uh - v, u)    180: (uw - u, uh - v)    270: (v, uw - u)
 * and each case below is that map's inverse applied to the region's corners.
 */
function unrotateRegion(
  rot: 0 | 90 | 180 | 270,
  uw: number,
  uh: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number
): { u0: number; v0: number; visW: number; visH: number } {
  switch (rot) {
    case 90:
      return { u0: y0, v0: uh - x1, visW: y1 - y0, visH: x1 - x0 }
    case 180:
      return { u0: uw - x1, v0: uh - y1, visW: x1 - x0, visH: y1 - y0 }
    case 270:
      return { u0: uw - y1, v0: x0, visW: y1 - y0, visH: x1 - x0 }
    default:
      return { u0: x0, v0: y0, visW: x1 - x0, visH: y1 - y0 }
  }
}
