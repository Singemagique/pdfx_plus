// Raster helpers for the OCR copy's preprocessing (DESIGN.md §3.4.4). Pure, DOM-free and
// deterministic: integer arithmetic only (sums stay exact in doubles far below 2^53), no
// transcendental Math, so every OS and every Node/V8 version produces the same bytes (§3.9.3's
// cross-OS diff). Images are 8-bit grey, rows top to bottom, `stride === width`.

import type { GrayImage } from '../engine/types'

/** A tightly packed grey image (`stride === width`). */
export interface Gray {
  width: number
  height: number
  data: Uint8Array
}

/** `img` without row padding (a copy only when it has a wider stride). */
export function packed(img: GrayImage): Gray {
  const stride = img.stride ?? img.width
  if (stride === img.width)
    return {
      width: img.width,
      height: img.height,
      data: img.data.subarray(0, img.width * img.height)
    }
  const out = new Uint8Array(img.width * img.height)
  for (let y = 0; y < img.height; y++)
    out.set(img.data.subarray(y * stride, y * stride + img.width), y * img.width)
  return { width: img.width, height: img.height, data: out }
}

export function copyGray(img: Gray): Gray {
  return { width: img.width, height: img.height, data: img.data.slice() }
}

/** 256-bin histogram. */
export function histogram(img: Gray): Float64Array {
  const h = new Float64Array(256)
  const d = img.data
  for (let i = 0; i < d.length; i++) h[d[i]]++
  return h
}

/**
 * Otsu's threshold on a histogram: the level t maximising the between-class variance, pixels
 * `< t` dark. Compared as cross-multiplied integers (no division), so ties resolve identically
 * everywhere: the lowest such t wins. A flat histogram gives 128.
 */
export function otsu(hist: Float64Array): number {
  let total = 0
  let sum = 0
  for (let i = 0; i < 256; i++) {
    total += hist[i]
    sum += i * hist[i]
  }
  let wB = 0
  let sumB = 0
  let best = -1
  let bestT = 128
  for (let t = 1; t < 256; t++) {
    wB += hist[t - 1]
    sumB += (t - 1) * hist[t - 1]
    const wF = total - wB
    if (wB === 0 || wF === 0) continue
    // σ_B² ∝ (sumB·total − sum·wB)² / (wB·wF). IEEE division and multiplication are exactly
    // rounded, so this is deterministic on every platform (only transcendentals are not).
    const n = sumB * total - sum * wB
    const v = (n / wB) * (n / wF)
    if (v > best) {
      best = v
      bestT = t
    }
  }
  return bestT
}

/** 1 where `img < threshold` (ink), else 0. */
export function binarize(img: Gray, threshold: number): Uint8Array {
  const d = img.data
  const out = new Uint8Array(d.length)
  for (let i = 0; i < d.length; i++) out[i] = d[i] < threshold ? 1 : 0
  return out
}

/**
 * Downscale by `k` (an integer) with a box average over each k × k block (edge blocks average the
 * pixels they have). Output size ceil(w / k) × ceil(h / k).
 */
export function boxDownscale(img: Gray, k: number): Gray {
  const { width: w, height: h, data } = img
  const ow = Math.ceil(w / k)
  const oh = Math.ceil(h / k)
  const sums = new Float64Array(ow * oh)
  const counts = new Float64Array(ow * oh)
  for (let y = 0; y < h; y++) {
    const oy = Math.floor(y / k) * ow
    const row = y * w
    for (let x = 0; x < w; x++) {
      const o = oy + Math.floor(x / k)
      sums[o] += data[row + x]
      counts[o]++
    }
  }
  const out = new Uint8Array(ow * oh)
  // Round half up: floor((2·sum + n) / (2n)).
  for (let i = 0; i < out.length; i++)
    out[i] = Math.floor((2 * sums[i] + counts[i]) / (2 * counts[i]))
  return { width: ow, height: oh, data: out }
}

/** The 1/4-scale copy every page-level analysis runs on (§3.4.4, §3.4.5). */
export const QUARTER = 4

/**
 * A white border of `pad` px on every side (§3.4.4 step 2: Tesseract finds text touching the edge
 * badly). Pixel (x, y) moves to (x + pad, y + pad); `toSource` undoes that.
 */
export function padWhite(img: Gray, pad: number): Gray {
  const w = img.width + 2 * pad
  const h = img.height + 2 * pad
  const out = new Uint8Array(w * h).fill(255)
  for (let y = 0; y < img.height; y++)
    out.set(img.data.subarray(y * img.width, (y + 1) * img.width), (y + pad) * w + pad)
  return { width: w, height: h, data: out }
}

/** A horizontal band of rows [y0, y1). */
export function cropRows(img: Gray, y0: number, y1: number): Gray {
  const a = Math.max(0, Math.min(img.height, y0))
  const b = Math.max(a, Math.min(img.height, y1))
  return {
    width: img.width,
    height: b - a,
    data: img.data.slice(a * img.width, b * img.width)
  }
}

/**
 * Upscale or downscale to `w × h` with bilinear interpolation in fixed point (Q8 weights, centre
 * aligned). Used only to resample the OCR copy; never the page image.
 */
export function resizeBilinear(img: Gray, w: number, h: number): Gray {
  const { width: sw, height: sh, data: src } = img
  const out = new Uint8Array(w * h)
  // Source coordinate of output pixel centre i: (i + 0.5)·sw/w − 0.5, in Q8 with integer maths.
  const xs = new Int32Array(w)
  const xf = new Int32Array(w)
  for (let i = 0; i < w; i++) {
    const q = Math.floor(((2 * i + 1) * sw * 256) / (2 * w)) - 128
    const c = Math.max(0, q)
    xs[i] = Math.min(sw - 1, c >> 8)
    xf[i] = xs[i] === sw - 1 ? 0 : c & 255
  }
  for (let j = 0; j < h; j++) {
    const q = Math.floor(((2 * j + 1) * sh * 256) / (2 * h)) - 128
    const c = Math.max(0, q)
    const y0 = Math.min(sh - 1, c >> 8)
    const fy = y0 === sh - 1 ? 0 : c & 255
    const y1 = Math.min(sh - 1, y0 + 1)
    const r0 = y0 * sw
    const r1 = y1 * sw
    for (let i = 0; i < w; i++) {
      const x0 = xs[i]
      const x1 = Math.min(sw - 1, x0 + 1)
      const fx = xf[i]
      const top = src[r0 + x0] * (256 - fx) + src[r0 + x1] * fx
      const bot = src[r1 + x0] * (256 - fx) + src[r1 + x1] * fx
      out[j * w + i] = (top * (256 - fy) + bot * fy + 32768) >> 16
    }
  }
  return { width: w, height: h, data: out }
}
