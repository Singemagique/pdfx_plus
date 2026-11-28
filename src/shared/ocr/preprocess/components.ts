// Connected components of a binary mask (8-connected), for border removal, despeckle and the
// Retry B gate (DESIGN.md §3.4.4, §3.4.5). Iterative flood fill over an explicit stack: no
// recursion, no allocation per pixel, deterministic order (row-major seeds).

export interface Component {
  /** Pixel count. */
  area: number
  x0: number
  y0: number
  /** Exclusive. */
  x1: number
  y1: number
  /** Touches the mask's outer edge. */
  edge: boolean
}

export interface Labelled {
  /** 0 = background; component i has label i + 1. */
  labels: Int32Array
  components: Component[]
}

/**
 * Label the 1-pixels of `mask` (`w × h`). Stops collecting stats past `maxComponents` (labels keep
 * going so the caller's painting still works); `labels` is only built when `wantLabels`.
 */
export function labelComponents(
  mask: Uint8Array,
  w: number,
  h: number,
  wantLabels = true
): Labelled {
  const labels = new Int32Array(w * h)
  const components: Component[] = []
  const stack = new Int32Array(w * h)
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start]) continue
    const label = components.length + 1
    let top = 0
    stack[top++] = start
    labels[start] = label
    let area = 0
    let x0 = w
    let y0 = h
    let x1 = 0
    let y1 = 0
    while (top > 0) {
      const p = stack[--top]
      const y = (p / w) | 0
      const x = p - y * w
      area++
      if (x < x0) x0 = x
      if (y < y0) y0 = y
      if (x + 1 > x1) x1 = x + 1
      if (y + 1 > y1) y1 = y + 1
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy
        if (ny < 0 || ny >= h) continue
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx
          if (nx < 0 || nx >= w || (dx === 0 && dy === 0)) continue
          const q = ny * w + nx
          if (mask[q] && !labels[q]) {
            labels[q] = label
            stack[top++] = q
          }
        }
      }
    }
    components.push({ area, x0, y0, x1, y1, edge: x0 === 0 || y0 === 0 || x1 === w || y1 === h })
  }
  return { labels: wantLabels ? labels : new Int32Array(0), components }
}
