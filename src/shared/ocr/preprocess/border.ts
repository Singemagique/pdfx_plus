// Border removal (DESIGN.md §3.4.4 step 2), the idea behind Leptonica's pixRemoveBorderConnComps:
// scanners and phone photos leave dark frames, page edges and binder shadows along the image edge,
// which Tesseract reads as "|", "l" and garbage lines. At 1/4 scale, dark (< 160) components that
// touch the image edge are painted white at full resolution; then a 16 px white pad is added
// (`padWhite`). Nothing moves: the pad is a pure translation that the caller's `toSource` undoes.
//
// Guard (an addition to the design's wording): a component covering more than half the page is a
// dark BACKGROUND (a dim photo, an inverted page), not a frame; erasing it would erase the text
// inside it, so it is left alone. Photo-like pages are normalised before this runs (background.ts).

import { labelComponents } from './components'
import { binarize, boxDownscale, QUARTER, type Gray } from './image'

export const BORDER_THRESHOLD = 160
export const BORDER_PAD = 16
/** A border component above this share of the 1/4-scale page is a background, not a frame. */
export const BORDER_MAX_SHARE_NUM = 1
export const BORDER_MAX_SHARE_DEN = 2

export interface BorderResult {
  image: Gray
  /** 1/4-scale pixels painted white (0 when nothing touched the edge). */
  removed: number
}

/** Paint the dark edge-connected components of `img` white (no pad; see `padWhite`). */
export function removeBorder(img: Gray): BorderResult {
  const q = boxDownscale(img, QUARTER)
  const mask = binarize(q, BORDER_THRESHOLD)
  const { labels, components } = labelComponents(mask, q.width, q.height)
  const limit = (q.width * q.height * BORDER_MAX_SHARE_NUM) / BORDER_MAX_SHARE_DEN
  const kill = new Uint8Array(components.length + 1)
  let removed = 0
  for (let i = 0; i < components.length; i++) {
    const c = components[i]
    if (c.edge && c.area <= limit) {
      kill[i + 1] = 1
      removed += c.area
    }
  }
  if (removed === 0) return { image: img, removed: 0 }
  const out = img.data.slice()
  const { width: w, height: h } = img
  for (let qy = 0; qy < q.height; qy++)
    for (let qx = 0; qx < q.width; qx++) {
      if (!kill[labels[qy * q.width + qx]]) continue
      const y1 = Math.min(h, (qy + 1) * QUARTER)
      const x1 = Math.min(w, (qx + 1) * QUARTER)
      for (let y = qy * QUARTER; y < y1; y++) out.fill(255, y * w + qx * QUARTER, y * w + x1)
    }
  return { image: { width: w, height: h, data: out }, removed }
}
