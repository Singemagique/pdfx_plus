// Geometry for the OCR copy (DESIGN.md §3.4.5): deterministic sin/cos (basic IEEE operations only;
// no transcendental Math, which is not guaranteed bit-identical across engines and OSes), affines
// in the PDF `cm` order shared with map.ts, and the exact and bilinear rotations of the OCR copy
// with the affine that maps its pixels back to the rendered raster's.
//
// Continuous pixel coordinates: pixel (i, j) covers [i, i+1) × [j, j+1), y down (hOCR's frame).

import type { Affine } from '../map'
import type { Gray } from './image'

export type { Affine }

export const IDENTITY: Affine = [1, 0, 0, 1, 0, 0]

const PI = 3.141592653589793

/** sin and cos of `deg` degrees: Taylor series on [−45°, 45°] plus exact quadrant swaps. */
export function sinCosDeg(deg: number): { sin: number; cos: number } {
  const q = Math.round(deg / 90)
  const r = deg - q * 90
  const x = (r * PI) / 180
  const x2 = x * x
  let s = x
  let c = 1
  let ts = x
  let tc = 1
  for (let n = 1; n <= 12; n++) {
    ts *= -x2 / (2 * n * (2 * n + 1))
    tc *= -x2 / ((2 * n - 1) * (2 * n))
    s += ts
    c += tc
  }
  switch (((q % 4) + 4) % 4) {
    case 0:
      return { sin: s, cos: c }
    case 1:
      return { sin: c, cos: -s }
    case 2:
      return { sin: -s, cos: -c }
    default:
      return { sin: -c, cos: s }
  }
}

/** `second ∘ first`: apply `first`, then `second`. */
export function compose(first: Affine, second: Affine): Affine {
  const [a1, b1, c1, d1, e1, f1] = first
  const [a2, b2, c2, d2, e2, f2] = second
  return [
    a2 * a1 + c2 * b1 + 0,
    b2 * a1 + d2 * b1 + 0,
    a2 * c1 + c2 * d1 + 0,
    b2 * c1 + d2 * d1 + 0,
    a2 * e1 + c2 * f1 + e2 + 0,
    b2 * e1 + d2 * f1 + f2 + 0
  ]
}

export function applyAffine(m: Affine, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
}

export const translate = (dx: number, dy: number): Affine => [1, 0, 0, 1, dx, dy]

export type QuarterTurns = 0 | 1 | 2 | 3

/**
 * Rotate clockwise (as seen on screen) by `turns` quarter turns, exactly. Returns the image and
 * `toSource`: its continuous pixel coords → the input's.
 */
export function rotateQuarterCW(img: Gray, turns: QuarterTurns): { image: Gray; toSource: Affine } {
  const { width: w, height: h, data: src } = img
  if (turns === 0) return { image: img, toSource: IDENTITY }
  const ow = turns === 2 ? w : h
  const oh = turns === 2 ? h : w
  const out = new Uint8Array(ow * oh)
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) {
      const v = src[row + x]
      // 1 turn: (x, y) → (h−1−y, x); 2: (w−1−x, h−1−y); 3: (y, w−1−x).
      if (turns === 1) out[x * ow + (h - 1 - y)] = v
      else if (turns === 2) out[(h - 1 - y) * ow + (w - 1 - x)] = v
      else out[(w - 1 - x) * ow + y] = v
    }
  }
  // Inverse in continuous coords: 1 turn src = (y', h − x'); 2: (w − x', h − y'); 3: (w − y', x').
  const toSource: Affine =
    turns === 1 ? [0, -1, 1, 0, 0, h] : turns === 2 ? [-1, 0, 0, -1, w, h] : [0, 1, -1, 0, w, 0]
  return { image: { width: ow, height: oh, data: out }, toSource }
}

/**
 * Rotate counter-clockwise (as seen on screen) by `deg` about the centre onto a canvas big enough
 * to hold every source pixel (uncovered pixels white), with bilinear sampling in fixed point: cos
 * and sin quantised to Q16, positions in Q17, weights Q8. `toSource` is the exact inverse of the
 * quantised map, so boxes found on the rotated copy land back where its pixels came from.
 */
export function rotateBilinear(img: Gray, deg: number): { image: Gray; toSource: Affine } {
  const { width: w, height: h, data: src } = img
  const { sin, cos } = sinCosDeg(deg)
  const cq = Math.round(cos * 65536)
  const sq = Math.round(sin * 65536)
  const acq = cq < 0 ? -cq : cq
  const asq = sq < 0 ? -sq : sq
  const ow = Math.ceil((w * acq + h * asq) / 65536)
  const oh = Math.ceil((w * asq + h * acq) / 65536)
  const out = new Uint8Array(ow * oh)
  const ONE = 131072
  // Source pixel-index coords of output pixel (i, j), Q17:
  //   U = (w−1)·65536 + cq·(2i+1−ow) − sq·(2j+1−oh);  V = (h−1)·65536 + sq·(2i+1−ow) + cq·(2j+1−oh)
  for (let j = 0; j < oh; j++) {
    const oy = 2 * j + 1 - oh
    const u0 = (w - 1) * 65536 - sq * oy
    const v0 = (h - 1) * 65536 + cq * oy
    const row = j * ow
    for (let i = 0; i < ow; i++) {
      const ox = 2 * i + 1 - ow
      const U = u0 + cq * ox
      const V = v0 + sq * ox
      const x0 = Math.floor(U / ONE)
      const y0 = Math.floor(V / ONE)
      if (x0 < -1 || y0 < -1 || x0 >= w || y0 >= h) {
        out[row + i] = 255
        continue
      }
      const fx = Math.floor((U - x0 * ONE) / 512)
      const fy = Math.floor((V - y0 * ONE) / 512)
      const inX0 = x0 >= 0
      const inX1 = x0 + 1 < w
      const inY0 = y0 >= 0
      const inY1 = y0 + 1 < h
      const p00 = inX0 && inY0 ? src[y0 * w + x0] : 255
      const p10 = inX1 && inY0 ? src[y0 * w + x0 + 1] : 255
      const p01 = inX0 && inY1 ? src[(y0 + 1) * w + x0] : 255
      const p11 = inX1 && inY1 ? src[(y0 + 1) * w + x0 + 1] : 255
      const top = p00 * (256 - fx) + p10 * fx
      const bot = p01 * (256 - fx) + p11 * fx
      out[row + i] = (top * (256 - fy) + bot * fy + 32768) >> 16
    }
  }
  // Continuous coords: src = Rᵀ·(dst − c_out) + c_in with Rᵀ = [[cq, −sq], [sq, cq]] / 65536.
  const a = cq / 65536
  const b = sq / 65536
  const c = -sq / 65536
  const d = cq / 65536
  const cxo = ow / 2
  const cyo = oh / 2
  const toSource: Affine = [
    a,
    b,
    c,
    d,
    w / 2 - (a * cxo + c * cyo) + 0,
    h / 2 - (b * cxo + d * cyo) + 0
  ]
  return { image: { width: ow, height: oh, data: out }, toSource }
}
