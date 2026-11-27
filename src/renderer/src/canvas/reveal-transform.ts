import { zoomIdentity, type ZoomTransform } from 'd3-zoom'
import type { Rect } from './layout'
import { MAX_SCALE, MIN_SCALE } from './zoom-constants'

export interface RevealMargins {
  top: number
  bottom: number
  side: number
}

/**
 * The transform that brings world rect `rect` into view, or null when it is already fully visible
 * inside the viewport minus `m`. It keeps the current zoom unless the rect would not fit, and then
 * zooms out just enough — never in. The rect is centred in the visible area along each axis it was
 * out of view on (both, when the zoom changes), clamped so content taller than the visible area is
 * never scrolled past its top or bottom (`contentHeight`, world px).
 */
export function computeRevealTransform(
  t: ZoomTransform,
  vp: { w: number; h: number },
  rect: Rect,
  m: RevealMargins,
  contentHeight?: number
): ZoomTransform | null {
  const left = t.invertX(m.side)
  const right = t.invertX(vp.w - m.side)
  const top = t.invertY(m.top)
  const bottom = t.invertY(vp.h - m.bottom)
  if (rect.x >= left && rect.x + rect.w <= right && rect.y >= top && rect.y + rect.h <= bottom) {
    return null
  }
  const availW = Math.max(1, vp.w - 2 * m.side)
  const availH = Math.max(1, vp.h - m.top - m.bottom)
  const k = Math.max(
    MIN_SCALE,
    Math.min(MAX_SCALE, t.k, availW / Math.max(1, rect.w), availH / Math.max(1, rect.h))
  )
  // At the same zoom, an axis on which the rect is already in view stays put: stepping to a page
  // further down must not also pan the collection sideways.
  const same = k === t.k
  const inX = rect.x >= left && rect.x + rect.w <= right
  const inY = rect.y >= top && rect.y + rect.h <= bottom
  const tx = same && inX ? t.x : vp.w / 2 - (rect.x + rect.w / 2) * k
  let ty = same && inY ? t.y : m.top + availH / 2 - (rect.y + rect.h / 2) * k
  if (contentHeight !== undefined && contentHeight * k > availH) {
    // Centring a page in the first or last row must not scroll past the end of the content.
    ty = Math.min(m.top, Math.max(vp.h - m.bottom - contentHeight * k, ty))
  }
  return zoomIdentity.translate(tx, ty).scale(k)
}
