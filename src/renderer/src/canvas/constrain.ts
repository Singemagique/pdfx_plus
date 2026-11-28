import { zoomIdentity, type ZoomBehavior, type ZoomTransform } from 'd3-zoom'
import { PAN_BOTTOM_MARGIN, PAN_SIDE_MARGIN, PAN_TOP_MARGIN } from './zoom-constants'

export type Extent = [[number, number], [number, number]]

/** Screen px of padding the content is held to along each edge of the viewport. */
export interface PanPadding {
  top: number
  bottom: number
  side: number
}

export const PAN_PADDING: PanPadding = {
  top: PAN_TOP_MARGIN,
  bottom: PAN_BOTTOM_MARGIN,
  side: PAN_SIDE_MARGIN
}

/**
 * The translate along one axis nearest `t` that keeps the content span [c0, c1] (world px, at
 * scale `k`) bounded by the window [w0, w1] (screen px):
 * - content longer than the window covers it: its start never comes past w0, its end never short
 *   of w1 — it pans until an edge reaches the padding, and no further;
 * - content shorter than the window stays entirely inside it, free to move within.
 * Both cases are the same clamp between "start at w0" and "end at w1", whichever order they come
 * in, so the bound is continuous in k (the two meet when the content is exactly the window's
 * length) and clamping twice changes nothing.
 */
function clampAxis(t: number, k: number, c0: number, c1: number, w0: number, w1: number): number {
  const startAtStart = w0 - k * c0
  const endAtEnd = w1 - k * c1
  const lo = Math.min(startAtStart, endAtEnd)
  const hi = Math.max(startAtStart, endAtEnd)
  // An unbounded content span (d3's default infinite translate extent) leaves the axis free.
  if (!(lo <= hi)) return t
  return Math.min(hi, Math.max(lo, t))
}

/**
 * `t` moved (scale kept) to the nearest transform at which the content box `content` (world px)
 * stays bounded by the viewport `viewport` (screen px) minus `pad`, per {@link clampAxis} on each
 * axis. Returns `t` itself when it is already in bounds.
 */
export function boundTransform(
  t: ZoomTransform,
  viewport: Extent,
  content: Extent,
  pad: PanPadding = PAN_PADDING
): ZoomTransform {
  const x = clampAxis(
    t.x,
    t.k,
    content[0][0],
    content[1][0],
    viewport[0][0] + pad.side,
    viewport[1][0] - pad.side
  )
  const y = clampAxis(
    t.y,
    t.k,
    content[0][1],
    content[1][1],
    viewport[0][1] + pad.top,
    viewport[1][1] - pad.bottom
  )
  return x === t.x && y === t.y ? t : zoomIdentity.translate(x, y).scale(t.k)
}

/**
 * d3-zoom's constrain: every gesture (drag, pinch, scaleBy/translateBy from the wheel and the zoom
 * buttons) passes through it. The translate extent is the content box (see useAutoFit), the extent
 * the viewport. d3 places a drag so the grabbed world point sits under the pointer, recomputed on
 * every move, so a clamp never accumulates: a drag pushed past a bound stays pinned there, and
 * picks up again, without a jump, once the pointer brings the grabbed point back within reach.
 */
export function panConstrain(
  transform: ZoomTransform,
  extent: Extent,
  translateExtent: Extent
): ZoomTransform {
  return boundTransform(transform, extent, translateExtent)
}

/**
 * `t` bounded the way gestures are, for a transform set programmatically: `zoom.transform` does
 * not run the constrain, so every target the app computes (fit, import focus, Find's reveal,
 * re-framing after a resize) is passed through this first.
 */
export function boundToViewport(
  vp: { clientWidth: number; clientHeight: number },
  zoom: ZoomBehavior<HTMLDivElement, unknown>,
  t: ZoomTransform
): ZoomTransform {
  return boundTransform(
    t,
    [
      [0, 0],
      [vp.clientWidth, vp.clientHeight]
    ],
    zoom.translateExtent()
  )
}
