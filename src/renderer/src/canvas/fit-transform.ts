import { zoomIdentity } from 'd3-zoom'
import { SINGLE_ROW_DOC_HEIGHT } from './layout'
import {
  MIN_SCALE,
  MAX_SCALE,
  FIT_MARGIN,
  MAX_FIT_SCALE,
  FIT_TOP_MARGIN,
  FIT_BOTTOM_MARGIN
} from './zoom-constants'

export interface FitDims {
  contentWidth: number
  contentHeight: number
}

export interface ViewportSize {
  clientWidth: number
  clientHeight: number
}

/**
 * The "fit" view: content width fills FIT_MARGIN of the viewport (capped at MAX_FIT_SCALE, and
 * never so large a one-row card overflows the height), centred horizontally.
 *
 * Vertically, content that fits is centred. Taller content is anchored instead of centred — the
 * world y `focusY` (default: the top of the content) sits FIT_TOP_MARGIN below the top edge,
 * clamped so the view never scrolls above the content or past its end.
 */
export function computeFitTransform(
  vp: ViewportSize,
  dims: FitDims,
  focusY = 0
): ReturnType<typeof zoomIdentity.translate> {
  const W = vp.clientWidth
  const H = vp.clientHeight
  const { contentWidth: cw, contentHeight: ch } = dims
  const k = Math.max(
    MIN_SCALE,
    Math.min(
      MAX_SCALE,
      MAX_FIT_SCALE,
      (W * FIT_MARGIN) / cw,
      (H * FIT_MARGIN) / SINGLE_ROW_DOC_HEIGHT
    )
  )
  const tx = (W - cw * k) / 2
  let ty: number
  if (ch * k <= H - 2 * FIT_TOP_MARGIN) {
    ty = (H - ch * k) / 2
  } else {
    const lowest = H - FIT_BOTTOM_MARGIN - ch * k
    ty = Math.min(FIT_TOP_MARGIN, Math.max(lowest, FIT_TOP_MARGIN - focusY * k))
  }
  return zoomIdentity.translate(tx, ty).scale(k)
}
