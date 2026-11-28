import { zoomIdentity, type ZoomBehavior, type ZoomTransform } from 'd3-zoom'
import { PAN_BOTTOM_MARGIN, PAN_SIDE_MARGIN, PAN_TOP_MARGIN } from './zoom-constants'

export type Extent = [[number, number], [number, number]]

/** What the pan bounds hold the content box (the zoom's translate extent) to, beyond the viewport. */
export interface PanBounds {
  /** Screen px of padding along the top, bottom and both sides of the viewport. */
  top: number
  bottom: number
  side: number
  /**
   * Screen px below the top edge that the top of content TALLER than the window may be brought
   * down to, when floating chrome (the find bar) covers more of the view than `top` does. At least
   * `top`; equal to it, the top bound is plain `top`.
   */
  topReach: number
  /**
   * World px past the content box's right edge the view may still be panned to (the outer half of
   * a round "Add page" button straddling a card's edge; see panReachWidth). On screen it is capped
   * at half the padded window, so however far the view is zoomed in, the cards still fill at least
   * half of it.
   */
  overhang: number
}

export const PAN_BOUNDS: PanBounds = {
  top: PAN_TOP_MARGIN,
  bottom: PAN_BOTTOM_MARGIN,
  side: PAN_SIDE_MARGIN,
  topReach: PAN_TOP_MARGIN,
  overhang: 0
}

/**
 * The translate along one axis nearest `t` that keeps the content span [c0, c1] (world px, at
 * scale `k`) bounded by the window [w0, w1] (screen px):
 * - content longer than the window covers it: its start never comes past w0 (or `w0Reach`, when
 *   that is further in), its end never short of w1 — it pans until an edge reaches the padding,
 *   and no further;
 * - content shorter than the window stays entirely inside [w0, w1], free to move within.
 * Both cases are one clamp between "start at w0 / w0Reach" and "end at w1", whichever order they
 * come in, so the bound is continuous in k (the cases meet when the content is the window's length)
 * and clamping twice changes nothing. With w0Reach > w0 the allowed range only grows: switching it
 * on never moves a view that was in bounds.
 */
function clampAxis(
  t: number,
  k: number,
  c0: number,
  c1: number,
  w0: number,
  w1: number,
  w0Reach = w0
): number {
  const startAtStart = w0 - k * c0
  const startAtReach = Math.max(w0, w0Reach) - k * c0
  const endAtEnd = w1 - k * c1
  const lo = Math.min(startAtStart, endAtEnd)
  const hi = Math.max(startAtReach, endAtEnd)
  // An infinite span (d3's default translate extent) already gives lo = -∞, hi = +∞: the axis is
  // free. Only a NaN in the extent or the scale fails this, and leaves the axis free too rather
  // than turning the transform into NaN.
  if (!(lo <= hi)) return t
  return Math.min(hi, Math.max(lo, t))
}

/**
 * `t` moved (scale kept) to the nearest transform at which the content box `content` (world px)
 * stays bounded by the viewport `viewport` (screen px) minus the padding in `bounds`, per
 * {@link clampAxis} on each axis. Returns `t` itself when it is already in bounds.
 */
export function boundTransform(
  t: ZoomTransform,
  viewport: Extent,
  content: Extent,
  bounds: PanBounds = PAN_BOUNDS
): ZoomTransform {
  const x0 = viewport[0][0] + bounds.side
  const x1 = viewport[1][0] - bounds.side
  // The overhang, capped on screen at half the window: at k it is overhang·k px wide, which
  // zoomed far enough in would otherwise let the view pan to an empty screen.
  const overhang = Math.max(0, Math.min(bounds.overhang, (x1 - x0) / (2 * t.k)))
  const x = clampAxis(t.x, t.k, content[0][0], content[1][0] + overhang, x0, x1)
  const y = clampAxis(
    t.y,
    t.k,
    content[0][1],
    content[1][1],
    viewport[0][1] + bounds.top,
    viewport[1][1] - bounds.bottom,
    viewport[0][1] + bounds.topReach
  )
  return x === t.x && y === t.y ? t : zoomIdentity.translate(x, y).scale(t.k)
}

/**
 * d3-zoom's constrain: every gesture (drag, pinch, scaleBy/translateBy from the wheel and the zoom
 * buttons) passes through it. The translate extent is the content box (see useAutoFit), the extent
 * the viewport. d3 places a drag so the grabbed world point sits under the pointer, recomputed on
 * every move, so a clamp never accumulates: a drag pushed past a bound stays pinned there, and
 * picks up again, without a jump, once the pointer brings the grabbed point back within reach.
 * d3 calls it with the first three arguments; createZoomBehavior passes the live `bounds`.
 */
export function panConstrain(
  transform: ZoomTransform,
  extent: Extent,
  translateExtent: Extent,
  bounds: PanBounds = PAN_BOUNDS
): ZoomTransform {
  return boundTransform(transform, extent, translateExtent, bounds)
}

/**
 * `t` bounded the way gestures are, for a transform set programmatically: `zoom.transform` does
 * not run the constrain, so every target the app computes (fit, import focus, Find's reveal,
 * re-framing after a resize) is passed through this first.
 */
export function boundToViewport(
  vp: { clientWidth: number; clientHeight: number },
  zoom: ZoomBehavior<HTMLDivElement, unknown>,
  t: ZoomTransform,
  bounds: PanBounds = PAN_BOUNDS
): ZoomTransform {
  return boundTransform(
    t,
    [
      [0, 0],
      [vp.clientWidth, vp.clientHeight]
    ],
    zoom.translateExtent(),
    bounds
  )
}
