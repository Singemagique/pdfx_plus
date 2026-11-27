// Faithful PNG → PDF image XObject embedding.
//
// pdf-lib's embedPng decodes every PNG to 8-bit RGBA and re-deflates it as DeviceRGB: 16-bit
// depth is truncated, grayscale/palette images triple in size, and the colour profile (iCCP),
// sRGB intent and gAMA are dropped — so exported colours shift from what the editor's <img>
// (which honours them) showed. This module writes the XObject itself and keeps the PNG's own
// model:
//
// - Colour model: gray → /DeviceGray, RGB → /DeviceRGB, palette → /Indexed over that base with
//   the PLTE lookup. Bit depth (1/2/4/8/16) is kept; 16 bpc needs PDF 1.5, pdf-lib writes 1.7.
// - Colour management, in PNG precedence order:
//     iCCP  → [/ICCBased <profile>] with /N and /Alternate (the profile's zlib bytes pass through).
//     sRGB  → plain Device space: every viewer already treats DeviceRGB/Gray as sRGB, so an
//             explicit profile would only add bytes.
//     gAMA  → (only when it differs from sRGB's ~1/2.2) baked into the samples so that
//             DeviceRGB (≈ display gamma 2.2) reproduces the same light: V' = V^(1/(g·2.2)).
//             Chosen over CalRGB/CalGray because CalRGB needs primaries we usually don't have
//             (an identity /Matrix would mean "RGB is XYZ" — wrong) and baking renders the same
//             in every viewer, so it is verifiable by plain pixel maths. Palette images bake the
//             PLTE entries only. cHRM is not used (sRGB primaries are assumed).
// - Alpha: an /SMask at the image's own depth (16-bit alpha stays 16-bit). tRNS (colour key on
//   gray/RGB, per-entry alpha on palettes) becomes an 8-bit SMask too — exact sample matching, and
//   it avoids viewers' uneven support for 16-bit colour-key /Mask arrays. A mask that would be
//   fully opaque is dropped, like pdf-lib does.
// - Size: when the IDAT holds only colour samples (no interleaved alpha, not Adam7-interlaced,
//   no gamma to bake) the original zlib stream passes straight through as /FlateDecode with PNG
//   predictor /DecodeParms — lossless, no re-encode. Otherwise the samples are decoded, split,
//   re-filtered row by row (PNG adaptive heuristic) and deflated with the same predictor.
//
// Anything unexpected (malformed data, an unsupported combination) falls back to pdf-lib's
// embedPng, logged once, so an export never regresses because of this module.

import { Unzlib, unzlibSync, zlibSync } from 'fflate'
import {
  PDFDocument,
  PDFHexString,
  PDFImage,
  PDFRef,
  PngEmbedder,
  type PDFContext,
  type PDFObject
} from 'pdf-lib'

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** Samples per pixel in the IDAT, by PNG colour type. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }
/** Allowed bit depths per colour type (PNG spec §11.2.2). */
const DEPTHS: Record<number, number[]> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16]
}

/** sRGB's nominal file gamma (1/2.2); gAMA within ±5 % of it is treated as sRGB. */
const SRGB_GAMMA_TOLERANCE = 0.05

class PngUnsupported extends Error {}

const fail = (msg: string): never => {
  throw new PngUnsupported(msg)
}

export interface PngInfo {
  width: number
  height: number
  bitDepth: number
  colorType: number
  interlaced: boolean
  palette?: Uint8Array
  trns?: Uint8Array
  /** zlib-compressed ICC profile bytes (as stored in iCCP) and the inflated profile. */
  icc?: { compressed: Uint8Array; profile: Uint8Array; n: 1 | 3 }
  srgb: boolean
  /** gAMA / 100000 (the file's encoding exponent), if present. */
  gamma?: number
  idat: Uint8Array
}

const u32 = (b: Uint8Array, o: number): number =>
  ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0

const concat = (parts: Uint8Array[]): Uint8Array => {
  if (parts.length === 1) return parts[0]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

/** Parse the chunks this module cares about. Throws PngUnsupported on malformed input. */
export function parsePng(bytes: Uint8Array): PngInfo {
  if (bytes.length < 8 || PNG_SIG.some((v, i) => bytes[i] !== v)) fail('not a PNG')
  let pos = 8
  let ihdr: Uint8Array | null = null
  let palette: Uint8Array | undefined
  let trns: Uint8Array | undefined
  let iccp: Uint8Array | undefined
  let srgb = false
  let gamma: number | undefined
  const idat: Uint8Array[] = []
  while (pos + 8 <= bytes.length) {
    const len = u32(bytes, pos)
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7])
    const start = pos + 8
    if (start + len > bytes.length) fail(`truncated ${type} chunk`)
    const data = bytes.subarray(start, start + len)
    pos = start + len + 4 // skip the CRC
    if (!ihdr && type !== 'IHDR') fail('IHDR is not the first chunk')
    if (type === 'IHDR') ihdr = data
    else if (type === 'PLTE') palette = data
    else if (type === 'tRNS') trns = data
    else if (type === 'iCCP') iccp = data
    else if (type === 'sRGB') srgb = true
    else if (type === 'gAMA' && len >= 4) gamma = u32(data, 0) / 100000
    else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
  }
  if (!ihdr || ihdr.length < 13) fail('missing IHDR')
  const h = ihdr as Uint8Array
  const width = u32(h, 0)
  const height = u32(h, 4)
  const [bitDepth, colorType, compression, filter, interlace] = h.subarray(8, 13)
  if (width === 0 || height === 0) fail('zero-sized image')
  if (!DEPTHS[colorType]?.includes(bitDepth)) fail(`bad depth ${bitDepth} / type ${colorType}`)
  if (compression !== 0 || filter !== 0 || interlace > 1)
    fail('unknown compression/filter/interlace')
  if (idat.length === 0) fail('no IDAT')
  if (colorType === 3) {
    if (!palette || palette.length === 0 || palette.length % 3 !== 0 || palette.length > 768) {
      fail('bad or missing PLTE')
    }
  } else {
    palette = undefined // a suggested palette on a truecolour image is irrelevant here
  }
  if (trns) {
    const ok =
      (colorType === 0 && trns.length >= 2) ||
      (colorType === 2 && trns.length >= 6) ||
      (colorType === 3 && trns.length > 0)
    if (!ok) trns = undefined // invalid for this type (e.g. on an alpha image): ignore, like libpng
  }
  return {
    width,
    height,
    bitDepth,
    colorType,
    interlaced: interlace === 1,
    palette,
    trns,
    icc: iccp ? readIcc(iccp, colorType) : undefined,
    srgb,
    gamma: gamma && gamma > 0 ? gamma : undefined,
    idat: concat(idat)
  }
}

/** The iCCP profile, or undefined when it is unusable (ignored, like a viewer would). */
function readIcc(data: Uint8Array, colorType: number): PngInfo['icc'] {
  const nul = data.indexOf(0)
  if (nul < 1 || nul > 79 || data[nul + 1] !== 0) return undefined
  const compressed = data.subarray(nul + 2)
  let profile: Uint8Array
  try {
    profile = unzlibSync(compressed)
  } catch {
    return undefined
  }
  if (profile.length < 132) return undefined
  const space = String.fromCharCode(profile[16], profile[17], profile[18], profile[19])
  const n = space === 'RGB ' ? 3 : space === 'GRAY' ? 1 : 0
  const want = colorType === 0 || colorType === 4 ? 1 : 3
  return n === want ? { compressed, profile, n } : undefined
}

// ---------------------------------------------------------------------------------------------
// Pixel data. Decoded images are kept as PNG scanlines — rows of [filter byte, ...stride bytes] —
// with every filter byte 0 (None), so an unfiltered buffer is itself a valid predictor stream.

interface Raster {
  data: Uint8Array
  stride: number // bytes per row, excluding the filter byte
}

const rowBytes = (width: number, samples: number, depth: number): number =>
  Math.ceil((width * samples * depth) / 8)

/**
 * Inflate the IDAT in 64 KiB slices, checking it yields at least `expected` bytes. When
 * `rowLen` is given (non-interlaced), each row's filter byte is validated on the fly. Returns the
 * first `expected` bytes when `keep`, else null (validation only — nothing large is allocated).
 */
function inflateIdat(
  idat: Uint8Array,
  expected: number,
  rowLen: number | null,
  keep: boolean
): Uint8Array | null {
  const out = keep ? new Uint8Array(expected) : null
  let n = 0
  let badFilter = false
  const z = new Unzlib((chunk) => {
    if (out && n < expected) out.set(chunk.subarray(0, Math.min(chunk.length, expected - n)), n)
    if (rowLen) {
      const end = Math.min(n + chunk.length, expected)
      for (let p = Math.ceil(n / rowLen) * rowLen; p < end; p += rowLen) {
        if (chunk[p - n] > 4) badFilter = true
      }
    }
    n += chunk.length
  })
  const SLICE = 1 << 16
  for (let i = 0; i < idat.length; i += SLICE) {
    z.push(idat.subarray(i, i + SLICE), i + SLICE >= idat.length)
  }
  if (n < expected) fail(`IDAT inflates to ${n} of ${expected} bytes`)
  if (badFilter) fail('invalid row filter')
  return out
}

/** Reverse the PNG row filters of `rows` rows starting at `off`, in place; zero the filter bytes. */
function unfilter(buf: Uint8Array, off: number, rows: number, stride: number, bpp: number): void {
  const rowLen = stride + 1
  for (let y = 0; y < rows; y++) {
    const f = off + y * rowLen
    const d = f + 1
    const p = y > 0 ? d - rowLen : -1
    const type = buf[f]
    if (type === 1) {
      for (let i = bpp; i < stride; i++) buf[d + i] += buf[d + i - bpp]
    } else if (type === 2) {
      if (p >= 0) for (let i = 0; i < stride; i++) buf[d + i] += buf[p + i]
    } else if (type === 3) {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? buf[d + i - bpp] : 0
        const b = p >= 0 ? buf[p + i] : 0
        buf[d + i] += (a + b) >> 1
      }
    } else if (type === 4) {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? buf[d + i - bpp] : 0
        const b = p >= 0 ? buf[p + i] : 0
        const c = p >= 0 && i >= bpp ? buf[p + i - bpp] : 0
        const pa = Math.abs(b - c)
        const pb = Math.abs(a - c)
        const pc = Math.abs(a + b - 2 * c)
        buf[d + i] += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
    } else if (type !== 0) {
      fail('invalid row filter')
    }
    buf[f] = 0
  }
}

const ADAM7: [number, number, number, number][] = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2]
]

/** Decode the IDAT to an unfiltered full-size raster at the native depth (handles Adam7). */
function decodeRaster(info: PngInfo): Raster {
  const { width, height, bitDepth } = info
  const samples = CHANNELS[info.colorType]
  const stride = rowBytes(width, samples, bitDepth)
  const bpp = Math.max(1, (samples * bitDepth) >> 3)
  if (!info.interlaced) {
    const data = inflateIdat(info.idat, height * (stride + 1), stride + 1, true)!
    unfilter(data, 0, height, stride, bpp)
    return { data, stride }
  }
  const passes = ADAM7.map(([x0, y0, dx, dy]) => {
    const w = Math.ceil((width - x0) / dx)
    const h = Math.ceil((height - y0) / dy)
    return { x0, y0, dx, dy, w, h, stride: w > 0 && h > 0 ? rowBytes(w, samples, bitDepth) : 0 }
  })
  const total = passes.reduce((n, p) => n + (p.stride ? p.h * (p.stride + 1) : 0), 0)
  const src = inflateIdat(info.idat, total, null, true)!
  const data = new Uint8Array(height * (stride + 1))
  const pixBytes = (samples * bitDepth) >> 3 // whole-byte pixels (depth ≥ 8)
  let off = 0
  for (const ps of passes) {
    if (!ps.stride) continue
    unfilter(src, off, ps.h, ps.stride, bpp)
    for (let y = 0; y < ps.h; y++) {
      const s = off + y * (ps.stride + 1) + 1
      const d = (ps.y0 + y * ps.dy) * (stride + 1) + 1
      for (let x = 0; x < ps.w; x++) {
        const X = ps.x0 + x * ps.dx
        if (bitDepth >= 8) {
          data.set(src.subarray(s + x * pixBytes, s + (x + 1) * pixBytes), d + X * pixBytes)
        } else {
          // Sub-byte depths are single-channel (gray / palette).
          const v =
            (src[s + ((x * bitDepth) >> 3)] >> (8 - bitDepth - ((x * bitDepth) & 7))) &
            ((1 << bitDepth) - 1)
          data[d + ((X * bitDepth) >> 3)] |= v << (8 - bitDepth - ((X * bitDepth) & 7))
        }
      }
    }
    off += ps.h * (ps.stride + 1)
  }
  return { data, stride }
}

/** Read sample `i` of the row whose data starts at `d`. */
function sampleAt(buf: Uint8Array, d: number, i: number, depth: number): number {
  if (depth === 8) return buf[d + i]
  if (depth === 16) return (buf[d + 2 * i] << 8) | buf[d + 2 * i + 1]
  const bit = i * depth
  return (buf[d + (bit >> 3)] >> (8 - depth - (bit & 7))) & ((1 << depth) - 1)
}

/** Split an interleaved gray+alpha / RGBA raster into colour and alpha rasters. */
function splitAlpha(
  r: Raster,
  info: PngInfo
): { color: Raster; alpha: Raster | null; colorSamples: number } {
  const { width, height, bitDepth } = info
  const samples = CHANNELS[info.colorType]
  const bps = bitDepth >> 3
  const cBytes = (samples - 1) * bps
  const cStride = width * cBytes
  const aStride = width * bps
  const color = new Uint8Array(height * (cStride + 1))
  const alpha = new Uint8Array(height * (aStride + 1))
  let opaque = true
  for (let y = 0; y < height; y++) {
    let s = y * (r.stride + 1) + 1
    let c = y * (cStride + 1) + 1
    let a = y * (aStride + 1) + 1
    for (let x = 0; x < width; x++) {
      for (let k = 0; k < cBytes; k++) color[c++] = r.data[s++]
      for (let k = 0; k < bps; k++) {
        const v = r.data[s++]
        if (v !== 255) opaque = false
        alpha[a++] = v
      }
    }
  }
  return {
    color: { data: color, stride: cStride },
    alpha: opaque ? null : { data: alpha, stride: aStride },
    colorSamples: samples - 1
  }
}

/** An 8-bit SMask raster from tRNS, or null when no pixel is actually transparent. */
function trnsMask(r: Raster, info: PngInfo): Raster | null {
  const { width, height, bitDepth, colorType, trns } = info
  if (!trns) return null
  const mask = new Uint8Array(height * (width + 1))
  let opaque = true
  const samples = CHANNELS[colorType]
  const key =
    colorType === 3
      ? null
      : Array.from({ length: samples }, (_, k) => ((trns[2 * k] << 8) | trns[2 * k + 1]) & 0xffff)
  for (let y = 0; y < height; y++) {
    const d = y * (r.stride + 1) + 1
    const m = y * (width + 1) + 1
    for (let x = 0; x < width; x++) {
      let a = 255
      if (key) {
        let match = true
        for (let k = 0; k < samples && match; k++) {
          match = sampleAt(r.data, d, x * samples + k, bitDepth) === key[k]
        }
        if (match) a = 0
      } else {
        const idx = sampleAt(r.data, d, x, bitDepth)
        if (idx < trns.length) a = trns[idx]
      }
      if (a !== 255) opaque = false
      mask[m + x] = a
    }
  }
  return opaque ? null : { data: mask, stride: width }
}

/** Whether tRNS can make any pixel transparent at all (a palette tRNS of all-255 cannot). */
const trnsMatters = (info: PngInfo): boolean =>
  !!info.trns && (info.colorType !== 3 || info.trns.some((a) => a !== 255))

/** The gamma exponent to bake, or null when the image is already (≈) sRGB-encoded. */
function bakeExponent(info: PngInfo): number | null {
  if (info.icc || info.srgb || !info.gamma) return null
  const ratio = info.gamma * 2.2
  return Math.abs(ratio - 1) > SRGB_GAMMA_TOLERANCE ? 1 / ratio : null
}

/** Apply V' = V^exp to every colour sample of `r` (depth 1/2/4/8 via a byte LUT, 16 via u16). */
function bakeGamma(r: Raster, rows: number, depth: number, exp: number): void {
  const rowLen = r.stride + 1
  if (depth === 16) {
    const lut = new Uint16Array(65536)
    for (let v = 0; v < 65536; v++) lut[v] = Math.round(65535 * Math.pow(v / 65535, exp))
    for (let y = 0; y < rows; y++) {
      const d = y * rowLen + 1
      for (let i = 0; i < r.stride; i += 2) {
        const v = lut[(r.data[d + i] << 8) | r.data[d + i + 1]]
        r.data[d + i] = v >> 8
        r.data[d + i + 1] = v & 0xff
      }
    }
    return
  }
  // Byte LUT: transform every packed sub-sample of each possible byte value.
  const max = (1 << depth) - 1
  const lut = new Uint8Array(256)
  for (let b = 0; b < 256; b++) {
    let out = 0
    for (let sh = 8 - depth; sh >= 0; sh -= depth) {
      const v = (b >> sh) & max
      out |= Math.round(max * Math.pow(v / max, exp)) << sh
    }
    lut[b] = out
  }
  for (let y = 0; y < rows; y++) {
    const d = y * rowLen + 1
    for (let i = 0; i < r.stride; i++) r.data[d + i] = lut[r.data[d + i]]
  }
}

/**
 * Re-apply PNG row filters in place (libpng's minimum-sum-of-absolute-differences heuristic;
 * depths below 8 stay unfiltered, as libpng recommends) and deflate the result.
 */
function encodeRaster(r: Raster, rows: number, bpp: number, depth: number): Uint8Array {
  const { data: buf, stride } = r
  const rowLen = stride + 1
  if (depth >= 8) {
    // Bottom-up, right-to-left: every read (left / up / up-left) still sees original samples.
    const pred = (f: number, d: number, p: number, i: number): number => {
      const x = buf[d + i]
      if (f === 0) return x
      const a = i >= bpp ? buf[d + i - bpp] : 0
      if (f === 1) return (x - a) & 0xff
      const b = p >= 0 ? buf[p + i] : 0
      if (f === 2) return (x - b) & 0xff
      if (f === 3) return (x - ((a + b) >> 1)) & 0xff
      const c = p >= 0 && i >= bpp ? buf[p + i - bpp] : 0
      const pa = Math.abs(b - c)
      const pb = Math.abs(a - c)
      const pc = Math.abs(a + b - 2 * c)
      return (x - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff
    }
    const cost = (v: number): number => (v < 128 ? v : 256 - v)
    for (let y = rows - 1; y >= 0; y--) {
      const d = y * rowLen + 1
      const p = y > 0 ? d - rowLen : -1
      // One pass scores all five filters (sum of residuals taken as signed bytes).
      let s0 = 0
      let s1 = 0
      let s2 = 0
      let s3 = 0
      let s4 = 0
      for (let i = 0; i < stride; i++) {
        const x = buf[d + i]
        const a = i >= bpp ? buf[d + i - bpp] : 0
        const b = p >= 0 ? buf[p + i] : 0
        const c = p >= 0 && i >= bpp ? buf[p + i - bpp] : 0
        const pa = Math.abs(b - c)
        const pb = Math.abs(a - c)
        const pc = Math.abs(a + b - 2 * c)
        s0 += cost(x)
        s1 += cost((x - a) & 0xff)
        s2 += cost((x - b) & 0xff)
        s3 += cost((x - ((a + b) >> 1)) & 0xff)
        s4 += cost((x - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff)
      }
      const sums = [s0, s1, s2, s3, s4]
      const best = sums.indexOf(Math.min(...sums))
      if (best !== 0) for (let i = stride - 1; i >= 0; i--) buf[d + i] = pred(best, d, p, i)
      buf[d - 1] = best
    }
  }
  return zlibSync(buf, { level: 6 })
}

// ---------------------------------------------------------------------------------------------
// The plan: everything is decoded/encoded first (pure, may throw), then written in one go, so a
// failure never leaves orphan objects in the document.

interface ImagePlan {
  width: number
  height: number
  bitDepth: number
  /** Samples per pixel of the colour stream (1 for gray / palette indices, 3 for RGB). */
  colors: number
  data: Uint8Array // zlib stream with PNG predictors
  space: 'gray' | 'rgb' | 'indexed'
  palette?: Uint8Array
  icc?: PngInfo['icc']
  smask?: { data: Uint8Array; bitDepth: number }
  /** True when `data` is the original IDAT, untouched. */
  passthrough: boolean
}

export function planPng(bytes: Uint8Array): ImagePlan {
  const info = parsePng(bytes)
  const { width, height, bitDepth, colorType } = info
  const exp = bakeExponent(info)
  const samples = CHANNELS[colorType]
  const hasAlphaChannel = colorType === 4 || colorType === 6
  const space = colorType === 3 ? 'indexed' : colorType === 0 || colorType === 4 ? 'gray' : 'rgb'

  let palette = info.palette
  if (palette && exp !== null) {
    const e = exp
    palette = palette.map((v) => Math.round(255 * Math.pow(v / 255, e))) // palette: bake PLTE only
  }

  const base = { width, height, bitDepth, space, palette, icc: info.icc } as const
  const canPass = !info.interlaced && !hasAlphaChannel && (exp === null || colorType === 3)
  if (canPass) {
    const stride = rowBytes(width, samples, bitDepth)
    if (!trnsMatters(info)) {
      inflateIdat(info.idat, height * (stride + 1), stride + 1, false) // validate only
      return { ...base, colors: samples, data: info.idat, passthrough: true }
    }
    const raster = decodeRaster(info)
    const mask = trnsMask(raster, info)
    return {
      ...base,
      colors: samples,
      data: info.idat,
      passthrough: true,
      smask: mask ? { data: encodeRaster(mask, height, 1, 8), bitDepth: 8 } : undefined
    }
  }

  const raster = decodeRaster(info)
  let color = raster
  let colors = samples
  let smask: ImagePlan['smask']
  if (hasAlphaChannel) {
    const split = splitAlpha(raster, info)
    color = split.color
    colors = split.colorSamples
    if (split.alpha) {
      const bpp = bitDepth >> 3
      smask = { data: encodeRaster(split.alpha, height, bpp, bitDepth), bitDepth }
    }
  } else if (trnsMatters(info)) {
    const mask = trnsMask(raster, info) // before baking: the key matches the stored samples
    if (mask) smask = { data: encodeRaster(mask, height, 1, 8), bitDepth: 8 }
  }
  if (exp !== null && colorType !== 3) bakeGamma(color, height, bitDepth, exp)
  const bpp = Math.max(1, (colors * bitDepth) >> 3)
  return {
    ...base,
    colors,
    data: encodeRaster(color, height, bpp, bitDepth),
    smask,
    passthrough: false
  }
}

function writePlan(context: PDFContext, plan: ImagePlan): PDFRef {
  const { width, height } = plan
  const parms = (colors: number, bpc: number): Record<string, number> => ({
    Predictor: 15,
    Colors: colors,
    BitsPerComponent: bpc,
    Columns: width
  })
  const device = plan.space === 'gray' ? 'DeviceGray' : 'DeviceRGB'
  let baseSpace: string | PDFObject = device
  if (plan.icc) {
    const profile = context.register(
      context.stream(plan.icc.compressed, {
        N: plan.icc.n,
        Alternate: plan.icc.n === 1 ? 'DeviceGray' : 'DeviceRGB',
        Filter: 'FlateDecode'
      })
    )
    baseSpace = context.obj(['ICCBased', profile])
  }
  let colorSpace: string | PDFObject = baseSpace
  if (plan.space === 'indexed') {
    const pal = plan.palette!
    let hex = ''
    for (const b of pal) hex += b.toString(16).padStart(2, '0')
    colorSpace = context.obj(['Indexed', baseSpace, pal.length / 3 - 1, PDFHexString.of(hex)])
  }
  let smaskRef: PDFRef | undefined
  if (plan.smask) {
    smaskRef = context.register(
      context.stream(plan.smask.data, {
        Type: 'XObject',
        Subtype: 'Image',
        Width: width,
        Height: height,
        ColorSpace: 'DeviceGray',
        BitsPerComponent: plan.smask.bitDepth,
        Filter: 'FlateDecode',
        DecodeParms: parms(1, plan.smask.bitDepth)
      })
    )
  }
  return context.register(
    context.stream(plan.data, {
      Type: 'XObject',
      Subtype: 'Image',
      Width: width,
      Height: height,
      ColorSpace: colorSpace,
      BitsPerComponent: plan.bitDepth,
      Filter: 'FlateDecode',
      DecodeParms: parms(plan.colors, plan.bitDepth),
      SMask: smaskRef
    })
  )
}

/**
 * A PDFImage for an XObject already written at `ref`. pdf-lib's PDFImage only accepts its own
 * embedder classes (instanceof check, private constructors), so this borrows PngEmbedder's
 * prototype; embedIntoContext is a no-op because the object is already in the document.
 */
function imageHandle(doc: PDFDocument, ref: PDFRef, width: number, height: number): PDFImage {
  const embedder = Object.create(PngEmbedder.prototype) as PngEmbedder
  Object.assign(embedder, {
    width,
    height,
    bitsPerComponent: 8,
    colorSpace: 'DeviceRGB',
    embedIntoContext: async () => ref
  })
  return PDFImage.of(ref, doc, embedder)
}

let warned = false

/**
 * Embed a PNG keeping its bit depth, colour model and colour profile (see the header comment).
 * Usable anywhere doc.embedPng's result is (page.drawImage etc.). Never throws for PNGs pdf-lib
 * could embed: anything this module can't handle is delegated to doc.embedPng.
 */
export async function embedPngFaithful(doc: PDFDocument, bytes: Uint8Array): Promise<PDFImage> {
  let plan: ImagePlan
  try {
    plan = planPng(bytes)
  } catch (e) {
    if (!warned) {
      warned = true
      console.warn('PNG embedded via pdf-lib fallback (colour profile/depth not preserved):', e)
    }
    return doc.embedPng(bytes)
  }
  const ref = writePlan(doc.context, plan)
  return imageHandle(doc, ref, plan.width, plan.height)
}
