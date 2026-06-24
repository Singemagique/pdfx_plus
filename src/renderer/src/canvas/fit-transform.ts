import { zoomIdentity } from 'd3-zoom'
import { MIN_SCALE, MAX_SCALE, FIT_MARGIN, TARGET_VISIBLE_DOCS } from './zoom-constants'

interface Dims {
  contentWidth: number
  contentHeight: number
  slotHeight: number
}

export function computeFitTransform(
  vp: HTMLDivElement,
  dims: Dims
): ReturnType<typeof zoomIdentity.translate> {
  const W = vp.clientWidth
  const H = vp.clientHeight
  const { contentWidth: cw, contentHeight: ch, slotHeight: slot } = dims
  const visibleDocs = Math.min(TARGET_VISIBLE_DOCS, Math.max(1, ch / slot))
  const k = Math.max(
    MIN_SCALE,
    Math.min(MAX_SCALE, (W * FIT_MARGIN) / cw, (H * FIT_MARGIN) / (visibleDocs * slot))
  )
  const tx = (W - cw * k) / 2
  const ty = (H - ch * k) / 2
  return zoomIdentity.translate(tx, ty).scale(k)
}
