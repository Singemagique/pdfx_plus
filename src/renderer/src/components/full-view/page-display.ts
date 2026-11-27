// Pure sizing for a page in full view (no DOM, no window): kept apart from geometry.ts, which reads
// `window.api` at import time, so node tests can import it.

import { fullPageInWindow, type PageFrame } from '../../page-geometry'

export interface Size {
  w: number
  h: number
}

/** Scale `pw × ph` uniformly to fit inside `vp`. */
export function fitInto(pw: number, ph: number, vp: Size): Size {
  const f = Math.min(vp.w / pw, vp.h / ph)
  return { w: pw * f, h: ph * f }
}

export interface FullViewBox {
  /** The DISPLAYED window (cropped, then rotated) fitted to the viewport: what zoom/pan clamp to. */
  dfit: Size
  /** The upright window box — `.full-page`'s CSS size, before its rotate() (dfit, transposed for 90/270). */
  box: Size
  /** The full page inside that box (`.page-frame`): overlays, Find and PageView live in this frame. */
  inner: { left: number; top: number; width: number; height: number; scale: number }
}

interface ViewState {
  zoom: number
  x: number
  y: number
}

const clampTo = (v: number, m: number): number => Math.min(m, Math.max(-m, v))

/** `view` with its pan clamped so the zoomed `fit` (the displayed page) never leaves the viewport. */
export function clampPan<V extends ViewState>(
  view: V,
  x: number,
  y: number,
  fit: Size,
  vp: Size
): V {
  const maxX = Math.max(0, (fit.w * view.zoom - vp.w) / 2)
  const maxY = Math.max(0, (fit.h * view.zoom - vp.h) / 2)
  return { ...view, x: clampTo(x, maxX), y: clampTo(y, maxY) }
}

/** Zoom to `nz` keeping the client point `focal` (default: the viewport centre) fixed. */
export function zoomAbout<V extends ViewState>(
  view: V,
  nz: number,
  fit: Size,
  vp: Size,
  focal?: { x: number; y: number }
): V {
  const r = nz / view.zoom
  const dx = (focal ? focal.x : vp.w / 2) - vp.w / 2
  const dy = (focal ? focal.y : vp.h / 2) - vp.h / 2
  return clampPan(
    { ...view, zoom: nz },
    dx * (1 - r) + r * view.x,
    dy * (1 - r) + r * view.y,
    fit,
    vp
  )
}

/** How a page sits in a full-view slide: fitted at its displayed (cropped + rotated) geometry. */
export function fullViewBox(frame: PageFrame, vp: Size): FullViewBox {
  const dfit = fitInto(frame.w, frame.h, vp)
  const quarter = frame.rotation === 90 || frame.rotation === 270
  const box = quarter ? { w: dfit.h, h: dfit.w } : { w: dfit.w, h: dfit.h }
  return { dfit, box, inner: fullPageInWindow(frame, box.w, box.h) }
}
