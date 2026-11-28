// Background normalisation (DESIGN.md §3.4.4 step 4), only on Retry A or for pages that look like
// a photo: estimate the paper's brightness B at 1/4 scale and divide it out, `out = clamp(255·I/B)`,
// so a lighting gradient or tinted paper becomes white paper with dark text again. Integer
// arithmetic throughout; nothing moves.
//
// The estimate: a grey max filter first (removes the text, which is darker than its paper), then
// a box blur (smooths the max filter's blocks). The design names only the box blur; without the
// max filter the blur averages text into B and the divide washes thin strokes out next to it.

import { boxDownscale, histogram, QUARTER, type Gray } from './image'

/** Paper-white and ink-black levels for the photo test. */
const WHITE = 224
const BLACK = 32

/**
 * Does the page look like a photo (§3.4.4: wide luma spread, no bilevel peaks)? True when fewer
 * than half of its pixels sit at either end of the grey range: a scan is mostly white paper (and
 * a binarised one entirely black and white), a photographed page is mostly mid-grey paper.
 */
export function looksLikePhoto(img: Gray): boolean {
  const h = histogram(img)
  let ends = 0
  for (let v = 0; v < BLACK; v++) ends += h[v]
  for (let v = WHITE; v < 256; v++) ends += h[v]
  return 2 * ends < img.data.length
}

/** A pixel rectangle: columns [x, x + w), rows [y, y + h). */
export interface PixelBox {
  x: number
  y: number
  w: number
  h: number
}

/**
 * The rows and columns of `img` that hold anything darker than paper white (null for a blank
 * page): where an image placed on a white page sits, or a scan's text block.
 */
export function contentBox(img: Gray): PixelBox | null {
  const { width: w, height: h, data } = img
  let x0 = w
  let x1 = -1
  let y0 = h
  let y1 = -1
  for (let y = 0; y < h; y++) {
    const row = y * w
    let first = -1
    let last = -1
    for (let x = 0; x < w; x++)
      if (data[row + x] < WHITE) {
        if (first < 0) first = x
        last = x
      }
    if (first < 0) continue
    if (y0 > y) y0 = y
    y1 = y
    if (first < x0) x0 = first
    if (last > x1) x1 = last
  }
  return y1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }
}

function cropBox(img: Gray, b: PixelBox): Gray {
  const out = new Uint8Array(b.w * b.h)
  for (let y = 0; y < b.h; y++) {
    const s = (b.y + y) * img.width + b.x
    out.set(img.data.subarray(s, s + b.w), y * b.w)
  }
  return { width: b.w, height: b.h, data: out }
}

/**
 * Where the page looks like a photo (§3.4.4), or null: the whole page when it does, else the part
 * of it that holds anything when THAT does. The second case is a photo placed on a white page
 * (PDFx fits an imported photo onto a Letter or A4 page, D4): the white margin alone pushes the
 * whole-page test past half, so the photo was never normalised, and Tesseract's page layout read
 * its tinted, unevenly lit paper as one picture block: 4 words of 111 [measured, PR11 review:
 * photoLike fitted to 612 × 792 pt]. A scan's text block is still mostly white paper, so it stays
 * a scan.
 */
export function photoRegion(img: Gray): PixelBox | null {
  const full: PixelBox = { x: 0, y: 0, w: img.width, h: img.height }
  if (looksLikePhoto(img)) return full
  const box = contentBox(img)
  if (!box || (box.w === img.width && box.h === img.height)) return null
  return looksLikePhoto(cropBox(img, box)) ? box : null
}

/**
 * `normalizeBackground` on `box` only (the paper estimate then never sees the page's white margin,
 * which would leave the photo's edges unnormalised); the rest of the page is kept as it is.
 */
export function normalizeRegion(img: Gray, box: PixelBox, dpi: number): Gray {
  if (box.x === 0 && box.y === 0 && box.w === img.width && box.h === img.height)
    return normalizeBackground(img, dpi)
  const n = normalizeBackground(cropBox(img, box), dpi)
  const out = img.data.slice()
  for (let y = 0; y < box.h; y++)
    out.set(n.data.subarray(y * box.w, (y + 1) * box.w), (box.y + y) * img.width + box.x)
  return { width: img.width, height: img.height, data: out }
}

/** Separable running max over a (2r + 1) window, clamped at the edges. */
function maxFilter(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const tmp = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) {
      let m = 0
      const a = Math.max(0, x - r)
      const b = Math.min(w - 1, x + r)
      for (let k = a; k <= b; k++) if (src[row + k] > m) m = src[row + k]
      tmp[row + x] = m
    }
  }
  const out = new Uint8Array(w * h)
  for (let x = 0; x < w; x++)
    for (let y = 0; y < h; y++) {
      let m = 0
      const a = Math.max(0, y - r)
      const b = Math.min(h - 1, y + r)
      for (let k = a; k <= b; k++) if (tmp[k * w + x] > m) m = tmp[k * w + x]
      out[y * w + x] = m
    }
  return out
}

/** Box mean over a (2r + 1)² window (clipped at the edges) via an integral image. */
function boxBlur(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const W = w + 1
  const ii = new Float64Array(W * (h + 1))
  for (let y = 0; y < h; y++) {
    let rowSum = 0
    for (let x = 0; x < w; x++) {
      rowSum += src[y * w + x]
      ii[(y + 1) * W + x + 1] = ii[y * W + x + 1] + rowSum
    }
  }
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r)
    const y1 = Math.min(h, y + r + 1)
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r)
      const x1 = Math.min(w, x + r + 1)
      const s = ii[y1 * W + x1] - ii[y0 * W + x1] - ii[y1 * W + x0] + ii[y0 * W + x0]
      const n = (y1 - y0) * (x1 - x0)
      out[y * w + x] = Math.floor((2 * s + n) / (2 * n))
    }
  }
  return out
}

/** Quarter-scale radii at 300 DPI: the max filter must cover a text line's half height. */
const MAX_RADIUS_300 = 6
const BLUR_RADIUS_300 = 12

/** `out = clamp(255·I/B)` with B the paper estimate, bilinearly upsampled (Q8) from 1/4 scale. */
export function normalizeBackground(img: Gray, dpi: number): Gray {
  const { width: w, height: h, data } = img
  const q = boxDownscale(img, QUARTER)
  const scale = (r: number): number => Math.max(1, Math.floor((r * dpi + 150) / 300))
  const bg = boxBlur(
    maxFilter(q.data, q.width, q.height, scale(MAX_RADIUS_300)),
    q.width,
    q.height,
    scale(BLUR_RADIUS_300)
  )
  const out = new Uint8Array(w * h)
  const qw = q.width
  const qh = q.height
  for (let y = 0; y < h; y++) {
    // Quarter-scale coordinate of the pixel centre, Q8: ((y + 0.5) / 4 − 0.5) · 256.
    const fyq = Math.max(0, (((2 * y + 1) * 256) >> 3) - 128)
    const by0 = Math.min(qh - 1, fyq >> 8)
    const by1 = Math.min(qh - 1, by0 + 1)
    const fy = by0 === qh - 1 ? 0 : fyq & 255
    for (let x = 0; x < w; x++) {
      const fxq = Math.max(0, (((2 * x + 1) * 256) >> 3) - 128)
      const bx0 = Math.min(qw - 1, fxq >> 8)
      const bx1 = Math.min(qw - 1, bx0 + 1)
      const fx = bx0 === qw - 1 ? 0 : fxq & 255
      const top = bg[by0 * qw + bx0] * (256 - fx) + bg[by0 * qw + bx1] * fx
      const bot = bg[by1 * qw + bx0] * (256 - fx) + bg[by1 * qw + bx1] * fx
      const b = Math.max(1, (top * (256 - fy) + bot * fy + 32768) >> 16)
      const i = y * w + x
      out[i] = Math.min(255, Math.floor((255 * data[i]) / b))
    }
  }
  return { width: w, height: h, data: out }
}
