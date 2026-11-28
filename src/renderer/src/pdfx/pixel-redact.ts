// Sub-image (pixel) redaction, the pure half (DESIGN.md §2 D3, PR12). No PDFium and no pdf-lib here:
// redact.ts drives PDFium with these helpers, and pixel-redact-doc.ts does the pdf-lib side.
//
// A redaction box that partially covers an image no longer has to remove the whole image. When the
// image is in scope (`ImagePlan`: unmasked DeviceGray, DeviceRGB or Indexed, no /Decode, no ICC, an
// XObject, at 1, 2, 4 or 8 bits per component) and drawn on an axis-aligned matrix, the pixels the
// box touches are blanked to black, on a NEW per-page image object: the shared XObject is never
// modified, so a letterhead or a scan reused on another page keeps its pixels there.
//
// The pixel mapping is conservative: the box goes through the inverse image matrix into sample
// space and is rounded OUTWARD (`pixelRect`), with a small epsilon on top, so every sample the box
// touches is blanked; one more column or row may go at an edge, never one less.
//
// Encoding: the new stream keeps the source's depth and colour space (1-bit sources, CCITT and
// JBIG2 included, stay 1-bit: as 8-bit Flate a fax page grows from tens of KB to MB) and is
// Flate-compressed. It must be at most `MAX_GROWTH` times the source's encoded stream, or the caller
// falls back to removing the whole image, which is also what happens to anything out of scope and
// to an image whose 8-bit raster is over `MAX_RASTER_BYTES`. `encodeWithin` gives up on the encode
// as soon as the gate is sure to fail (a JPEG scan), rather than after it.

import { Zlib, zlibSync } from 'fflate'

/** The new stream may be at most this many times the source's encoded stream. */
export const MAX_GROWTH = 2

/**
 * The largest image redacted pixel by pixel, in bytes of its 8-bit raster (W × H × the interim's
 * channels): an A4 page at 400 dpi in RGB, an A3 page at 300 dpi in grey. A bigger one is removed
 * whole. The pass runs on the renderer thread and its rasters live in the shared PDFium heap, which
 * never shrinks [measured in review on a copy of a0cfe9c: an A0 300 dpi RGB scan took 16 s and
 * left 1.26 GB of WASM heap].
 */
export const MAX_RASTER_BYTES = 48 * 2 ** 20

/** Outward slack of the pixel mapping, in samples (PDFium matrices are float32). */
const PIXEL_EPSILON = 1e-3

/** Relative size of b and c, against a and d, below which a matrix counts as axis-aligned. */
const AXIS_TOLERANCE = 1e-6

/** The colour space of an in-scope image. */
export type PlanColorSpace =
  | { kind: 'DeviceGray' }
  | { kind: 'DeviceRGB' }
  | {
      kind: 'Indexed'
      base: 'DeviceGray' | 'DeviceRGB'
      hival: number
      /** The decoded lookup table, (hival + 1) × base components bytes (at least). */
      lookup: Uint8Array
    }

/** How an in-scope image is decoded and re-encoded. */
export interface ImagePlan {
  /**
   * 'samples': the stream's samples, after its non-image filters (Flate, LZW, RunLength, ASCIIHex,
   * ASCII85), from FPDFImageObj_GetImageDataDecoded. 'bitmap': an image codec (CCITT, JBIG2, DCT)
   * PDFium decodes to a bitmap with FPDFImageObj_GetBitmap.
   */
  decode: 'samples' | 'bitmap'
  colorSpace: PlanColorSpace
  /** Bits per component of the source, and of the new stream. */
  bpc: 1 | 2 | 4 | 8
}

/** An image XObject of a redacted page, as the pdf-lib pre-pass found it in the source. */
export interface ImageCandidate {
  width: number
  height: number
  /** The stream's bytes as stored (still encoded): how the PDFium object is matched to it. */
  raw: Uint8Array
  /** How to redact it, or why it is out of scope (the whole image is then removed). */
  plan: ImagePlan | { skip: string }
}

/** pageIndex → the image XObjects its resources hold. */
export type PageCandidates = ReadonlyMap<number, readonly ImageCandidate[]>

/** An FS_MATRIX: user = (a·u + c·v + e, b·u + d·v + f) for the unit square (u, v). */
export type Matrix = readonly [a: number, b: number, c: number, d: number, e: number, f: number]

/** A rectangle in unrotated user space (points). */
export interface UserRect {
  x: number
  y: number
  w: number
  h: number
}

/** Inclusive sample rectangle: columns c0..c1, rows r0..r1 (row 0 is the image's top row). */
export interface PixelRect {
  c0: number
  r0: number
  c1: number
  r1: number
}

/**
 * True when the matrix maps the unit square onto an axis-aligned rectangle without rotating it a
 * quarter turn or skewing it: b and c (relatively) zero, a and d non-zero and finite. A mirrored or
 * half-turned placement (a or d negative) still is: the mapping below handles the signs.
 */
export function isAxisAligned(m: Matrix): boolean {
  const [a, b, c, d, e, f] = m
  if (![a, b, c, d, e, f].every(Number.isFinite)) return false
  const scale = Math.max(Math.abs(a), Math.abs(d))
  if (!(Math.abs(a) > 0 && Math.abs(d) > 0)) return false
  return Math.abs(b) <= AXIS_TOLERANCE * scale && Math.abs(c) <= AXIS_TOLERANCE * scale
}

/**
 * The samples of a W × H image placed by the axis-aligned matrix `m` that the user-space `rect`
 * touches, rounded outward; null when the rect misses the image. The image's row 0 is at v = 1
 * (PDF images are stored top row first), column 0 at u = 0.
 */
export function pixelRect(m: Matrix, W: number, H: number, rect: UserRect): PixelRect | null {
  const [a, , , d, e, f] = m
  const u0 = (rect.x - e) / a
  const u1 = (rect.x + rect.w - e) / a
  const v0 = (rect.y - f) / d
  const v1 = (rect.y + rect.h - f) / d
  const uMin = Math.min(u0, u1) * W
  const uMax = Math.max(u0, u1) * W
  // Rows count down from the top: v = 1 is row 0.
  const yMin = (1 - Math.max(v0, v1)) * H
  const yMax = (1 - Math.min(v0, v1)) * H
  if (![uMin, uMax, yMin, yMax].every(Number.isFinite)) return null
  const c0 = Math.max(0, Math.floor(uMin - PIXEL_EPSILON))
  const c1 = Math.min(W - 1, Math.ceil(uMax + PIXEL_EPSILON) - 1)
  const r0 = Math.max(0, Math.floor(yMin - PIXEL_EPSILON))
  const r1 = Math.min(H - 1, Math.ceil(yMax + PIXEL_EPSILON) - 1)
  if (c0 > c1 || r0 > r1) return null
  return { c0, r0, c1, r1 }
}

/** Colour components per sample of a plan's colour space. */
export const componentsOf = (cs: PlanColorSpace): number => (cs.kind === 'DeviceRGB' ? 3 : 1)

/** Bytes per row of W samples of `nc` components at `bpc` bits (rows are byte-padded). */
export const rowBytesOf = (W: number, nc: number, bpc: number): number =>
  Math.ceil((W * nc * bpc) / 8)

/** Channels of the 8-bit raster a plan's samples expand to (an Indexed palette's base). */
export const channelsOf = (cs: PlanColorSpace): 1 | 3 =>
  cs.kind === 'DeviceRGB' || (cs.kind === 'Indexed' && cs.base === 'DeviceRGB') ? 3 : 1

/**
 * The sample value that paints black (or the darkest colour an Indexed palette has): 0 for
 * DeviceGray and DeviceRGB at every depth, for Indexed the darkest palette entry a `bpc`-bit
 * sample can hold (an entry past 2^bpc − 1 cannot be written at that depth).
 */
export function blankValue(cs: PlanColorSpace, bpc: number): number {
  if (cs.kind !== 'Indexed') return 0
  const n = cs.base === 'DeviceRGB' ? 3 : 1
  let best = 0
  let bestLuma = Infinity
  for (let i = 0; i <= Math.min(cs.hival, (1 << bpc) - 1); i++) {
    const p = cs.lookup.subarray(i * n, i * n + n)
    const luma = n === 3 ? 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2] : p[0]
    if (luma < bestLuma) {
      bestLuma = luma
      best = i
    }
  }
  return best
}

/**
 * Set every component of every sample inside `rects` to `value` (the bpc low bits are used), in
 * packed rows of W samples × nc components × bpc bits. Mutates `samples`.
 */
export function blankSamples(
  samples: Uint8Array,
  W: number,
  nc: number,
  bpc: number,
  rects: readonly PixelRect[],
  value: number
): void {
  const stride = rowBytesOf(W, nc, bpc)
  const v = value & ((1 << bpc) - 1)
  for (const { c0, r0, c1, r1 } of rects)
    for (let r = r0; r <= r1; r++) {
      const row = r * stride
      if (bpc === 8) {
        samples.fill(v, row + c0 * nc, row + (c1 + 1) * nc)
        continue
      }
      for (let k = c0 * nc; k < (c1 + 1) * nc; k++) {
        const bit = k * bpc
        const byte = row + (bit >> 3)
        const shift = 8 - bpc - (bit & 7)
        samples[byte] = (samples[byte] & ~(((1 << bpc) - 1) << shift)) | (v << shift)
      }
    }
}

/** Component `k` of row `r` (0-based, packed `bpc`-bit samples, rows `stride` bytes). */
function sampleAt(samples: Uint8Array, stride: number, r: number, k: number, bpc: number): number {
  if (bpc === 8) return samples[r * stride + k]
  const bit = k * bpc
  const shift = 8 - bpc - (bit & 7)
  return (samples[r * stride + (bit >> 3)] >> shift) & ((1 << bpc) - 1)
}

/**
 * The samples expanded to an 8-bit grey (1 channel) or RGB (3 channels) raster, W × H, unpadded:
 * what PDFium is handed for the interim image object (a palette applied, low depths scaled up).
 */
export function expandSamples(
  samples: Uint8Array,
  W: number,
  H: number,
  plan: ImagePlan
): { channels: 1 | 3; data: Uint8Array } {
  const cs = plan.colorSpace
  const nc = componentsOf(cs)
  const stride = rowBytesOf(W, nc, plan.bpc)
  const max = (1 << plan.bpc) - 1
  // 8-bit Gray or RGB already is that raster (rows of W × nc bytes, no padding): a view, no copy.
  if (cs.kind !== 'Indexed' && plan.bpc === 8)
    return { channels: nc as 1 | 3, data: samples.subarray(0, W * H * nc) }
  if (cs.kind !== 'Indexed') {
    const out = new Uint8Array(W * H * nc)
    for (let r = 0; r < H; r++)
      for (let k = 0; k < W * nc; k++)
        out[r * W * nc + k] = Math.round((sampleAt(samples, stride, r, k, plan.bpc) * 255) / max)
    return { channels: nc as 1 | 3, data: out }
  }
  const n = cs.base === 'DeviceRGB' ? 3 : 1
  const out = new Uint8Array(W * H * n)
  for (let r = 0; r < H; r++)
    for (let x = 0; x < W; x++) {
      // An index past hival is clamped, as PDFium and pdf.js do.
      const i = Math.min(sampleAt(samples, stride, r, x, plan.bpc), cs.hival)
      for (let j = 0; j < n; j++) out[(r * W + x) * n + j] = cs.lookup[i * n + j] ?? 0
    }
  return { channels: n as 1 | 3, data: out }
}

/** Above this many sample bytes, `encodeWithin` estimates the size from bands first. */
const ESTIMATE_MIN_BYTES = 2 ** 20
/** Bands of rows the estimate compresses, each 1/64 of the rows (1/8 of the image in all). */
const ESTIMATE_BANDS = 8
/** The estimate gives up only this far over the limit (it may be off; the full encode is exact). */
const ESTIMATE_MARGIN = 1.25
/** Input fed to the streaming encoder between two checks of its output size. */
const ENCODE_CHUNK = 2 ** 20

/**
 * The new image stream's bytes (the samples, Flate-compressed at level 6, no predictor), or null as
 * soon as it is clear they would exceed `limit` bytes, so an image that fails the growth gate (most
 * JPEG scans: their 8-bit Flate copy is over 2× [measured in review on a copy of a0cfe9c, A4
 * 300 dpi, q60–q75]) does not pay for a full encode. A large
 * raster is first estimated from ESTIMATE_BANDS bands of rows spread over it (Flate's 32 KB window
 * spans only a few rows of a scan, so bands compress about as the whole does); then it is encoded
 * in chunks, stopping once the output passes `limit`. Rows are `rowBytes` long.
 */
export function encodeWithin(
  samples: Uint8Array,
  rowBytes: number,
  limit: number
): Uint8Array | null {
  const rows = rowBytes > 0 ? Math.floor(samples.length / rowBytes) : 0
  if (samples.length > ESTIMATE_MIN_BYTES && rows >= 64) {
    const bandRows = Math.ceil(rows / 64)
    let read = 0
    let wrote = 0
    for (let k = 0; k < ESTIMATE_BANDS; k++) {
      const r0 = Math.min(rows - bandRows, Math.floor(((k + 0.5) * rows) / ESTIMATE_BANDS))
      const band = samples.subarray(r0 * rowBytes, (r0 + bandRows) * rowBytes)
      read += band.length
      wrote += zlibSync(band, { level: 6 }).length
    }
    if ((wrote / read) * samples.length > ESTIMATE_MARGIN * limit) return null
  }
  const chunks: Uint8Array[] = []
  let size = 0
  const z = new Zlib({ level: 6 }, (chunk) => {
    chunks.push(chunk)
    size += chunk.length
  })
  for (let off = 0; ; off += ENCODE_CHUNK) {
    const end = Math.min(samples.length, off + ENCODE_CHUNK)
    z.push(samples.subarray(off, end), end === samples.length)
    if (size > limit) return null
    if (end === samples.length) break
  }
  const out = new Uint8Array(size)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

/** A pixel-redacted image of one page: what pixel-redact-doc.ts swaps into the saved file. */
export interface PixelReplacement {
  width: number
  height: number
  /** The 8-bit interim raster handed to FPDFImageObj_SetBitmap (how the object is found again). */
  interim: { channels: 1 | 3; data: Uint8Array }
  /** The final stream: its depth, colour space and Flate-compressed samples. */
  final: { bpc: 1 | 2 | 4 | 8; colorSpace: PlanColorSpace; data: Uint8Array }
  /** The source's encoded stream length (the growth gate's reference). */
  sourceLength: number
  /** The blanked sample rectangles. */
  rects: PixelRect[]
  /** The image's bounds in unrotated user space (left, bottom, right, top). */
  box: { l: number; b: number; r: number; t: number }
}

/**
 * The candidate whose stored bytes are `raw` (and whose size is W × H), or null when none is, or
 * when two candidates with these bytes disagree on how to redact them (the caller then removes the
 * whole image).
 */
export function matchCandidate(
  candidates: readonly ImageCandidate[],
  W: number,
  H: number,
  raw: Uint8Array
): ImageCandidate | null {
  let found: ImageCandidate | null = null
  for (const c of candidates) {
    if (c.width !== W || c.height !== H || c.raw.length !== raw.length) continue
    if (!bytesEqual(c.raw, raw)) continue
    if (found && planKey(found.plan) !== planKey(c.plan)) return null
    found = c
  }
  return found
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function planKey(plan: ImageCandidate['plan']): string {
  if ('skip' in plan) return 'skip'
  const cs = plan.colorSpace
  const lut = cs.kind === 'Indexed' ? `${cs.base}:${cs.hival}:${Array.from(cs.lookup).join(',')}` : '' // prettier-ignore
  return `${plan.decode}:${plan.bpc}:${cs.kind}:${lut}`
}
