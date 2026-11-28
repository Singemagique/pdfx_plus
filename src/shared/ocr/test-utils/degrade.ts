// Seeded, bit-reproducible image degradations for the synthetic OCR corpus (DESIGN.md §3.9.1).
// Test-only, DOM-free.
//
// Determinism rules (so a raster hashes the same on every OS and every Node/V8 version):
// - Randomness comes only from sfc32 (32-bit integer ops), seeded explicitly. Never Math.random.
// - No Math.sin/cos/exp/log/pow/sqrt (their last-ulp results are implementation-defined). The few
//   real-valued constants (Gaussian taps, cos/sin of a rotation angle) are computed by `expNeg` and
//   `sinCosDeg` below from +, −, ×, ÷ only. Those are correctly rounded IEEE-754 operations and JS
//   forbids fused multiply-add contraction, so every engine gets the same bits. They are then
//   quantised to integers, and the per-pixel kernels are pure integer arithmetic on exact doubles
//   (all intermediates stay far below 2^53).
// - Math.floor/round/min/max/abs/ceil are exact and allowed.
// - `jpegRoundTrip` uses jpeg-js 0.4.4. Its encoder and decoder use no transcendental functions
//   (grep of lib/encoder.js and lib/decoder.js: only Math.round/floor/ceil) [measured], but its
//   forward DCT and colour conversion use floating multiply/add; those are also deterministic for
//   the reason above. It is still kept out of the cross-version hash guards because a jpeg-js bump
//   could legitimately change its output.
//
// Images are 8-bit grey, row-major, top-left origin: `data[y * width + x]`, 0 = black, 255 = white.

export interface GreyImage {
  width: number
  height: number
  data: Uint8Array
}

export function makeImage(width: number, height: number, fill = 255): GreyImage {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1)
    throw new Error(`bad image size ${width}x${height}`)
  return { width, height, data: new Uint8Array(width * height).fill(fill) }
}

export function cloneImage(img: GreyImage): GreyImage {
  return { width: img.width, height: img.height, data: new Uint8Array(img.data) }
}

/** Mean grey level (exact sum / n). */
export function meanLevel(img: GreyImage): number {
  let sum = 0
  for (let i = 0; i < img.data.length; i++) sum += img.data[i]
  return sum / img.data.length
}

// ---------------------------------------------------------------------------------------------
// PRNG

/** A 32-bit generator: each call returns an unsigned integer in [0, 2^32). */
export type Rng = () => number

/** sfc32 (Chris Doty-Humphrey's Small Fast Counting generator), 32-bit state words. */
export function sfc32(a: number, b: number, c: number, d: number): Rng {
  return () => {
    a |= 0
    b |= 0
    c |= 0
    d |= 0
    const t = (((a + b) | 0) + d) | 0
    d = (d + 1) | 0
    a = b ^ (b >>> 9)
    b = (c + (c << 3)) | 0
    c = (c << 21) | (c >>> 11)
    c = (c + t) | 0
    return t >>> 0
  }
}

/** FNV-1a over a string's UTF-16 units (a stable stream id from an op name). */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * An independent stream for (seed, stream): sfc32 seeded with fixed constants, the seed and the
 * stream id, then 15 outputs discarded (the author's recommended warm-up). Separate streams per op
 * mean adding an op to a preset never shifts the noise another op draws.
 */
export function createRng(seed: number, stream: string | number = 0): Rng {
  const sid = typeof stream === 'string' ? fnv1a(stream) : stream >>> 0
  const rng = sfc32(0x9e3779b9, seed >>> 0, sid, (seed / 4294967296) >>> 0 || 0x243f6a88)
  for (let i = 0; i < 15; i++) rng()
  return rng
}

// ---------------------------------------------------------------------------------------------
// Deterministic real-valued helpers (basic IEEE operations only)

/** e^(−x) for x ≥ 0 from a Taylor series with halving range reduction (no Math.exp). */
export function expNeg(x: number): number {
  if (!(x >= 0)) throw new Error('expNeg: x must be ≥ 0')
  let k = 0
  let r = x
  while (r > 0.5) {
    r /= 2
    k++
  }
  // e^(−r), |r| ≤ 0.5: 20 terms is far below double epsilon.
  let term = 1
  let sum = 1
  for (let n = 1; n <= 20; n++) {
    term *= -r / n
    sum += term
  }
  for (let i = 0; i < k; i++) sum *= sum
  return sum
}

const PI = 3.141592653589793

/** sin and cos of `deg` degrees from Taylor series on [−45°, 45°] plus exact quadrant swaps. */
export function sinCosDeg(deg: number): { sin: number; cos: number } {
  // Reduce to q quarter turns + r ∈ [−45, 45].
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

// ---------------------------------------------------------------------------------------------
// Affine bookkeeping (continuous pixel coordinates: pixel (i, j) covers [i, i+1) × [j, j+1))

/** x' = a·x + c·y + e, y' = b·x + d·y + f (the PDF `cm` matrix order). */
export type Affine = [number, number, number, number, number, number]

export const IDENTITY: Affine = [1, 0, 0, 1, 0, 0]

/** `v + 0` turns −0 into +0, so JSON round trips (which drop the sign of zero) compare equal. */
const unsign = (v: number): number => v + 0

/** `second ∘ first`: apply `first`, then `second`. */
export function composeAffine(first: Affine, second: Affine): Affine {
  const [a1, b1, c1, d1, e1, f1] = first
  const [a2, b2, c2, d2, e2, f2] = second
  return unsignAll([
    a2 * a1 + c2 * b1,
    b2 * a1 + d2 * b1,
    a2 * c1 + c2 * d1,
    b2 * c1 + d2 * d1,
    a2 * e1 + c2 * f1 + e2,
    b2 * e1 + d2 * f1 + f2
  ])
}

function unsignAll(m: Affine): Affine {
  return m.map(unsign) as Affine
}

export function invertAffine(m: Affine): Affine {
  const [a, b, c, d, e, f] = m
  const det = a * d - b * c
  if (det === 0) throw new Error('singular affine')
  return unsignAll([
    d / det,
    -b / det,
    -c / det,
    a / det,
    (c * f - d * e) / det,
    (b * e - a * f) / det
  ])
}

export function applyAffine(m: Affine, x: number, y: number): [number, number] {
  return [unsign(m[0] * x + m[2] * y + m[4]), unsign(m[1] * x + m[3] * y + m[5])]
}

/** A degraded image plus the map from its input's pixel frame to its own. */
export interface Degraded {
  image: GreyImage
  /** Input continuous pixel coords → output continuous pixel coords. */
  transform: Affine
}

// ---------------------------------------------------------------------------------------------
// Geometric ops

/**
 * Rotate counter-clockwise (as seen on screen) by `deg` about the image centre, keeping the canvas
 * size; uncovered pixels get `fill`. Inverse mapping with bilinear sampling, all fixed point:
 * cos/sin are quantised to Q16 (`cq`, `sq`), the sample position is computed in Q17 from
 * half-pixel centre offsets and the bilinear weights are Q8. Rotation by 0 is an exact copy.
 */
export function rotate(img: GreyImage, deg: number, fill = 255): Degraded {
  const { width: w, height: h, data: src } = img
  const { sin, cos } = sinCosDeg(deg)
  const cq = Math.round(cos * 65536)
  const sq = Math.round(sin * 65536)
  const out = new Uint8Array(w * h)
  // Source pixel-index coords of output pixel (i, j) in Q17:
  //   U = (w−1)·65536 + cq·(2i+1−w) − sq·(2j+1−h)
  //   V = (h−1)·65536 + sq·(2i+1−w) + cq·(2j+1−h)
  const ONE = 131072
  for (let j = 0; j < h; j++) {
    const oy = 2 * j + 1 - h
    const u0 = (w - 1) * 65536 - sq * oy
    const v0 = (h - 1) * 65536 + cq * oy
    for (let i = 0; i < w; i++) {
      const ox = 2 * i + 1 - w
      const U = u0 + cq * ox
      const V = v0 + sq * ox
      const x0 = Math.floor(U / ONE)
      const y0 = Math.floor(V / ONE)
      const fx = Math.floor((U - x0 * ONE) / 512) // Q8
      const fy = Math.floor((V - y0 * ONE) / 512)
      const p00 = x0 >= 0 && x0 < w && y0 >= 0 && y0 < h ? src[y0 * w + x0] : fill
      const p10 = x0 + 1 >= 0 && x0 + 1 < w && y0 >= 0 && y0 < h ? src[y0 * w + x0 + 1] : fill
      const p01 = x0 >= 0 && x0 < w && y0 + 1 >= 0 && y0 + 1 < h ? src[(y0 + 1) * w + x0] : fill
      const p11 =
        x0 + 1 >= 0 && x0 + 1 < w && y0 + 1 >= 0 && y0 + 1 < h ? src[(y0 + 1) * w + x0 + 1] : fill
      const top = p00 * (256 - fx) + p10 * fx
      const bot = p01 * (256 - fx) + p11 * fx
      out[j * w + i] = (top * (256 - fy) + bot * fy + 32768) >> 16
    }
  }
  // The kernel's inverse map, in continuous coords about the centre (cx, cy), is
  //   p_src = Mi·(p_out − c) + c with Mi = [[cq, −sq], [sq, cq]] / 65536,
  // so the forward GT map is its exact inverse: [[cq, sq], [−sq, cq]] · 65536 / (cq² + sq²).
  const k = 65536 / (cq * cq + sq * sq)
  const a = cq * k
  const b = -sq * k
  const c = sq * k
  const d = cq * k
  const cx = w / 2
  const cy = h / 2
  const transform = unsignAll([a, b, c, d, cx - a * cx - c * cy, cy - b * cx - d * cy])
  return { image: { width: w, height: h, data: out }, transform }
}

/**
 * Exact rotation by quarter turns, counter-clockwise as seen on screen (turns = 1: 90° CCW; the
 * canvas becomes h × w). Pixel (x, y) → (y, w−1−x) for one turn.
 */
export function rotateQuarter(img: GreyImage, turns: number): Degraded {
  const t = ((turns % 4) + 4) % 4
  const { width: w, height: h, data: src } = img
  if (t === 0) return { image: cloneImage(img), transform: [...IDENTITY] }
  const ow = t === 2 ? w : h
  const oh = t === 2 ? h : w
  const out = new Uint8Array(ow * oh)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = src[y * w + x]
      if (t === 1) out[(w - 1 - x) * ow + y] = v
      else if (t === 2) out[(h - 1 - y) * ow + (w - 1 - x)] = v
      else out[x * ow + (h - 1 - y)] = v
    }
  // Continuous coords: 1 turn (x, y) → (y, w − x); 2 → (w − x, h − y); 3 → (h − y, x).
  const transform: Affine =
    t === 1 ? [0, -1, 1, 0, 0, w] : t === 2 ? [-1, 0, 0, -1, w, h] : [0, 1, -1, 0, h, 0]
  return { image: { width: ow, height: oh, data: out }, transform }
}

/**
 * Box-filter taps for one axis. Output sample o covers the source span [o·sLen, (o+1)·sLen) in
 * units where one source sample spans dLen; the weight of source sample k is the overlap of
 * [k·dLen, (k+1)·dLen) with that span. The weights of each output sum to sLen.
 */
function boxTaps(sLen: number, dLen: number): { k0: number; weights: number[] }[] {
  const taps: { k0: number; weights: number[] }[] = []
  for (let o = 0; o < dLen; o++) {
    const lo = o * sLen
    const hi = lo + sLen
    const k0 = Math.floor(lo / dLen)
    const k1 = Math.ceil(hi / dLen)
    const weights: number[] = []
    for (let k = k0; k < k1; k++)
      weights.push(Math.min(hi, (k + 1) * dLen) - Math.max(lo, k * dLen))
    taps.push({ k0, weights })
  }
  return taps
}

/**
 * Resize to `width × height` with an area-averaging box filter: exact integer weights, the
 * horizontal pass kept unrounded (sums ≤ 255·W) and one final rounding (half up) after the
 * vertical pass, so there is no double-rounding bias. Works for downscaling and upscaling. The GT
 * map is a pure scale: x' = x·W'/W, y' = y·H'/H.
 */
export function resample(img: GreyImage, width: number, height: number): Degraded {
  const { width: w, height: h, data: src } = img
  const tx = boxTaps(w, width)
  const ty = boxTaps(h, height)
  const tmp = new Float64Array(width * h)
  for (let y = 0; y < h; y++)
    for (let o = 0; o < width; o++) {
      const { k0, weights } = tx[o]
      let acc = 0
      for (let t = 0; t < weights.length; t++) acc += weights[t] * src[y * w + k0 + t]
      tmp[y * width + o] = acc
    }
  const out = new Uint8Array(width * height)
  const denom = w * h
  for (let o = 0; o < height; o++) {
    const { k0, weights } = ty[o]
    for (let x = 0; x < width; x++) {
      let acc = 0
      for (let t = 0; t < weights.length; t++) acc += weights[t] * tmp[(k0 + t) * width + x]
      out[o * width + x] = Math.floor((2 * acc + denom) / (2 * denom))
    }
  }
  return {
    image: { width, height, data: out },
    transform: [width / w, 0, 0, height / h, 0, 0]
  }
}

// ---------------------------------------------------------------------------------------------
// Photometric ops (no geometry change)

/**
 * Integer Gaussian taps for σ (px): radius ⌈3σ⌉, weights e^(−x²/2σ²) quantised to sum exactly
 * 2^14 (the centre tap absorbs the rounding remainder).
 */
export function gaussianKernel(sigma: number): Int32Array {
  if (!(sigma > 0)) throw new Error('sigma must be > 0')
  const r = Math.max(1, Math.ceil(3 * sigma))
  const raw: number[] = []
  let total = 0
  for (let x = -r; x <= r; x++) {
    const g = expNeg((x * x) / (2 * sigma * sigma))
    raw.push(g)
    total += g
  }
  const k = new Int32Array(2 * r + 1)
  let sum = 0
  for (let i = 0; i < k.length; i++) {
    if (i === r) continue
    k[i] = Math.round((raw[i] * 16384) / total)
    sum += k[i]
  }
  k[r] = 16384 - sum
  return k
}

/** Mirror index into [0, n) (reflect-101: …2 1 | 0 1 2 … n−2 n−1 | n−2 …). */
function mirror(i: number, n: number): number {
  if (n === 1) return 0
  const period = 2 * (n - 1)
  let m = i % period
  if (m < 0) m += period
  return m < n ? m : period - m
}

/**
 * Separable Gaussian blur, integer kernel (see `gaussianKernel`), mirrored edges. The horizontal
 * pass is kept unrounded in Q14 (≤ 255·2^14) and the result is rounded once, half up, from Q28
 * (sums < 2^36, exact in a double).
 */
export function gaussianBlur(img: GreyImage, sigma: number): GreyImage {
  const k = gaussianKernel(sigma)
  const r = (k.length - 1) / 2
  const { width: w, height: h, data: src } = img
  const tmp = new Uint32Array(w * h)
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) {
      let acc = 0
      for (let t = -r; t <= r; t++) acc += k[t + r] * src[row + mirror(x + t, w)]
      tmp[row + x] = acc
    }
  }
  const ONE = 268435456 // 2^28
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let acc = 0
      for (let t = -r; t <= r; t++) acc += k[t + r] * tmp[mirror(y + t, h) * w + x]
      out[y * w + x] = Math.floor((acc + ONE / 2) / ONE)
    }
  return { width: w, height: h, data: out }
}

const clamp8 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v)

/**
 * Additive Gaussian noise of standard deviation σ grey levels, from the Irwin–Hall approximation:
 * the sum of 12 independent uniform 16-bit integers U has mean 12·65535/2 and variance
 * 12·(65536²−1)/12 ≈ 2^32, so (ΣU − 393210) / 65536 is ≈ N(0, 1) (bounded at ±6σ). σ is taken in
 * Q8; each pixel draws 6 sfc32 outputs (two 16-bit halves each).
 */
export function gaussianNoise(img: GreyImage, sigma: number, rng: Rng): GreyImage {
  const sQ8 = Math.round(sigma * 256)
  const out = new Uint8Array(img.data.length)
  for (let p = 0; p < out.length; p++) {
    let s = 0
    for (let n = 0; n < 6; n++) {
      const u = rng()
      s += (u & 0xffff) + (u >>> 16)
    }
    // n = round((s − 393210)·σ / 65536) in exact integers: numerator < 2^40.
    const num = (s - 393210) * sQ8
    const noise = Math.floor((2 * num + 16777216) / 33554432) // round(num / 2^24), halves up
    out[p] = clamp8(img.data[p] + noise)
  }
  return { width: img.width, height: img.height, data: out }
}

/** Salt-and-pepper: each pixel independently becomes 0 or 255 (50/50) with probability p. */
export function saltAndPepper(img: GreyImage, p: number, rng: Rng): GreyImage {
  const threshold = Math.floor(p * 4294967296)
  const out = new Uint8Array(img.data)
  for (let i = 0; i < out.length; i++) if (rng() < threshold) out[i] = rng() & 1 ? 255 : 0
  return { width: img.width, height: img.height, data: out }
}

/** v < threshold → 0, else 255. */
export function binarize(img: GreyImage, threshold = 128): GreyImage {
  const out = new Uint8Array(img.data.length)
  for (let i = 0; i < out.length; i++) out[i] = img.data[i] < threshold ? 0 : 255
  return { width: img.width, height: img.height, data: out }
}

/** Integer BT.601 luma of an sRGB colour: (77R + 150G + 29B + 128) >> 8. */
export function lumaOf(r: number, g: number, b: number): number {
  return (77 * r + 150 * g + 29 * b + 128) >> 8
}

/**
 * Paper colour: a multiply blend, v' = round(v · level / 255), so white paper becomes `level` and
 * black ink stays black. The rasters are grey, so a coloured paper is applied as its BT.601 luma
 * (see `lumaOf`).
 */
export function background(img: GreyImage, level: number): GreyImage {
  const out = new Uint8Array(img.data.length)
  for (let i = 0; i < out.length; i++) out[i] = Math.floor((2 * img.data[i] * level + 255) / 510)
  return { width: img.width, height: img.height, data: out }
}

/**
 * Uneven lighting: a linear gain ramp from `fromQ8` at the top-left corner to `toQ8` at the
 * bottom-right corner (Q8 gains, 256 = ×1), along x + y. v' = clamp((v · gain + 128) >> 8).
 */
export function lightingGradient(img: GreyImage, fromQ8: number, toQ8: number): GreyImage {
  const { width: w, height: h, data: src } = img
  const out = new Uint8Array(w * h)
  const span = Math.max(1, w + h - 2)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const gain = fromQ8 + Math.floor(((toQ8 - fromQ8) * (x + y)) / span)
      out[y * w + x] = clamp8((src[y * w + x] * gain + 128) >> 8)
    }
  return { width: w, height: h, data: out }
}

/** The JPEG codec `jpegRoundTrip` drives (jpeg-js 0.4.4's encode/decode, injected or imported). */
export interface JpegCodec {
  encode(
    img: { width: number; height: number; data: Uint8Array },
    quality: number
  ): { data: Uint8Array }
  decode(
    bytes: Uint8Array,
    opts: { useTArray: true; formatAsRGBA: boolean }
  ): { width: number; height: number; data: Uint8Array }
}

/**
 * Encode as a baseline JPEG at `quality` (jpeg-js: 4:4:4 YCbCr from R = G = B = v) and decode
 * again; the result is the BT.601 luma of the decoded RGB. Returns the JPEG bytes too.
 */
export function jpegRoundTrip(
  img: GreyImage,
  quality: number,
  codec: JpegCodec
): { image: GreyImage; jpeg: Uint8Array } {
  const n = img.width * img.height
  const rgba = new Uint8Array(n * 4)
  for (let i = 0; i < n; i++) {
    const v = img.data[i]
    rgba[4 * i] = v
    rgba[4 * i + 1] = v
    rgba[4 * i + 2] = v
    rgba[4 * i + 3] = 255
  }
  const jpeg = new Uint8Array(
    codec.encode({ width: img.width, height: img.height, data: rgba }, quality).data
  )
  const dec = codec.decode(jpeg, { useTArray: true, formatAsRGBA: false })
  if (dec.width !== img.width || dec.height !== img.height) throw new Error('jpeg size mismatch')
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++)
    out[i] = lumaOf(dec.data[3 * i], dec.data[3 * i + 1], dec.data[3 * i + 2])
  return { image: { width: img.width, height: img.height, data: out }, jpeg }
}

/** Crop the rectangle [x, x+w) × [y, y+h). */
export function crop(img: GreyImage, x: number, y: number, w: number, h: number): GreyImage {
  if (x < 0 || y < 0 || x + w > img.width || y + h > img.height)
    throw new Error('crop out of range')
  const out = new Uint8Array(w * h)
  for (let r = 0; r < h; r++)
    out.set(img.data.subarray((y + r) * img.width + x, (y + r) * img.width + x + w), r * w)
  return { width: w, height: h, data: out }
}
