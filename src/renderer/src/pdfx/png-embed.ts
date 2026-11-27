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
//     gAMA  → (only when it differs from sRGB's ~1/2.2) baked into the samples the way Chromium
//             (the editor's <img>) displays them: decoded to linear light with V^(1/g), then
//             re-encoded with the piecewise sRGB transfer function, V' = sRGB_OETF(V^(1/g)), so
//             DeviceRGB/Gray (= sRGB) reproduces the same light. Chosen over CalRGB/CalGray
//             because CalRGB needs primaries we usually don't have (an identity /Matrix would
//             mean "RGB is XYZ" — wrong) and baking renders the same in every viewer, so it is
//             verifiable by plain pixel maths. Palette images bake the PLTE entries only; gray
//             below 8 bits becomes /Indexed /DeviceGray over a baked 8-bit lookup (requantising
//             to 1/2/4 bits would collapse levels). cHRM is not used (sRGB primaries are assumed).
// - Alpha: an /SMask at the image's own depth (16-bit alpha stays 16-bit). tRNS (colour key on
//   gray/RGB, per-entry alpha on palettes) becomes an 8-bit SMask too — exact sample matching, and
//   it avoids viewers' uneven support for 16-bit colour-key /Mask arrays. A mask that would be
//   fully opaque is dropped, like pdf-lib does.
// - Size: when the IDAT holds only colour samples (no interleaved alpha, not Adam7-interlaced,
//   no gamma to bake into the samples, nothing stored past the image's own bytes) the original
//   zlib stream passes straight through as /FlateDecode with PNG predictor /DecodeParms —
//   lossless, no re-encode. Otherwise the samples are decoded, split, re-filtered row by row (PNG
//   adaptive heuristic) and deflated with the same predictor.
// - Bombs: the IDAT is inflated only as far as the image needs and an iCCP only up to 4 MB, so a
//   tiny file can't inflate to GBs; a second IHDR is rejected (see images.ts's pixel cap).
//
// Anything unexpected (malformed data, an unsupported combination) falls back to pdf-lib's
// embedPng, logged once, so an export never regresses because of this module.

import { Unzlib, zlibSync } from 'fflate'
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

/**
 * Largest inflated iCCP profile accepted. Real profiles are tens of KB (rarely ~1 MB) and libpng
 * caps chunks at 8 MB; past this the profile is ignored, so a tiny iCCP can't inflate to GBs.
 */
const MAX_ICC_BYTES = 4 << 20

/**
 * Deflate expands at most ~1032:1 (a 258-byte match per 2 bits), so a push of `k` input bytes
 * yields at most ~1032·k output bytes. Input slices are sized from that to bound the overshoot.
 */
const MAX_DEFLATE_RATIO = 1032

/**
 * Input that may legitimately remain after the last needed IDAT byte: the end-of-block code,
 * empty flush blocks and the 4-byte Adler-32. More than this means the IDAT carries extra data.
 */
const IDAT_TAIL_SLACK = 64

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
    if (type === 'IHDR') {
      // pdf-lib (and images.ts's pixel cap) must not see different dimensions than we do.
      if (ihdr) fail('duplicate IHDR')
      ihdr = data
    } else if (type === 'PLTE') palette = data
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

/**
 * Inflate a zlib stream, giving up (null) as soon as the output exceeds `cap` bytes or the data
 * is corrupt. Input goes in 1 KiB slices, so at most ~1 MiB is inflated past the cap.
 */
function inflateCapped(src: Uint8Array, cap: number): Uint8Array | null {
  const parts: Uint8Array[] = []
  let n = 0
  const z = new Unzlib((chunk) => {
    n += chunk.length
    if (n <= cap) parts.push(chunk)
  })
  const SLICE = 1 << 10
  try {
    for (let i = 0; i < src.length && n <= cap; i += SLICE) {
      z.push(src.subarray(i, i + SLICE), i + SLICE >= src.length)
    }
  } catch {
    return null
  }
  return n <= cap ? concat(parts) : null
}

/**
 * The iCCP profile, or undefined when it is unusable — ignored, like a viewer would, and the image
 * is embedded without colour management rather than failing.
 */
function readIcc(data: Uint8Array, colorType: number): PngInfo['icc'] {
  const nul = data.indexOf(0)
  if (nul < 1 || nul > 79 || data[nul + 1] !== 0) return undefined
  const compressed = data.subarray(nul + 2)
  // Bounded: an iCCP is passed through to the PDF verbatim, so a decompression bomb here would
  // both exhaust memory now and crash viewers later (PDFium aborts on a 1 GiB ICC stream).
  const profile = inflateCapped(compressed, MAX_ICC_BYTES)
  if (!profile || profile.length < 132) return undefined
  // A real ICC header declares its own size (big-endian u32 at 0) and carries the 'acsp'
  // signature at 36; anything else is not a profile a PDF consumer could use.
  if (u32(profile, 0) !== profile.length) return undefined
  if (String.fromCharCode(profile[36], profile[37], profile[38], profile[39]) !== 'acsp') {
    return undefined
  }
  const space = String.fromCharCode(profile[16], profile[17], profile[18], profile[19])
  const n = space === 'RGB ' ? 3 : space === 'GRAY' ? 1 : 0
  // Deliberate: the profile must match the image's colour type. The PNG spec forbids an RGB
  // profile on a gray image (and vice versa); Chromium applies it anyway, but /ICCBased with /N 3
  // over 1-component samples is invalid PDF, so such a profile is ignored (plain DeviceGray).
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
 * Inflate the IDAT until it has yielded `expected` bytes (fails if it can't). When `rowLen` is
 * given (non-interlaced), each row's filter byte is validated on the fly. `data` holds the first
 * `expected` bytes when `keep`, else null (validation only — nothing large is allocated).
 *
 * Inflation stops as soon as `expected` bytes are out: input is pushed in slices sized from the
 * bytes still needed (deflate's ~1032:1 ceiling), so a bomb IDAT overshoots by ≤ ~1 MiB instead
 * of running on to GBs. `trailing` reports an IDAT that holds more than the image — inflated
 * output past `expected`, or unread input beyond a stream tail — which must not be passed
 * through verbatim (the PDF would carry the junk).
 */
function inflateIdat(
  idat: Uint8Array,
  expected: number,
  rowLen: number | null,
  keep: boolean
): { data: Uint8Array | null; trailing: boolean } {
  const out = keep ? new Uint8Array(expected) : null
  let n = 0
  let badFilter = false
  const z = new Unzlib((chunk) => {
    if (n < expected) {
      const end = Math.min(n + chunk.length, expected)
      if (out) out.set(chunk.subarray(0, end - n), n)
      if (rowLen) {
        for (let p = Math.ceil(n / rowLen) * rowLen; p < end; p += rowLen) {
          if (chunk[p - n] > 4) badFilter = true
        }
      }
    }
    n += chunk.length
  })
  let i = 0
  while (i < idat.length && n < expected) {
    const want = Math.ceil((expected - n) / MAX_DEFLATE_RATIO)
    const next = Math.min(idat.length, i + Math.min(1 << 16, Math.max(1 << 10, want)))
    z.push(idat.subarray(i, next), next >= idat.length)
    i = next
  }
  if (n < expected) fail(`IDAT inflates to ${n} of ${expected} bytes`)
  if (badFilter) fail('invalid row filter')
  return { data: out, trailing: n > expected || idat.length - i > IDAT_TAIL_SLACK }
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

/**
 * Decode the IDAT to an unfiltered full-size raster at the native depth (handles Adam7).
 * `trailing` is inflateIdat's: the IDAT holds more than the image needs.
 */
function decodeRaster(info: PngInfo): { raster: Raster; trailing: boolean } {
  const { width, height, bitDepth } = info
  const samples = CHANNELS[info.colorType]
  const stride = rowBytes(width, samples, bitDepth)
  const bpp = Math.max(1, (samples * bitDepth) >> 3)
  if (!info.interlaced) {
    const { data, trailing } = inflateIdat(info.idat, height * (stride + 1), stride + 1, true)
    unfilter(data!, 0, height, stride, bpp)
    return { raster: { data: data!, stride }, trailing }
  }
  const passes = ADAM7.map(([x0, y0, dx, dy]) => {
    const w = Math.ceil((width - x0) / dx)
    const h = Math.ceil((height - y0) / dy)
    return { x0, y0, dx, dy, w, h, stride: w > 0 && h > 0 ? rowBytes(w, samples, bitDepth) : 0 }
  })
  const total = passes.reduce((n, p) => n + (p.stride ? p.h * (p.stride + 1) : 0), 0)
  const { data: inflated, trailing } = inflateIdat(info.idat, total, null, true)
  const src = inflated!
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
  return { raster: { data, stride }, trailing }
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

/**
 * The decoding exponent 1/g of a gAMA to bake, or null when the image is already (≈)
 * sRGB-encoded (or colour-managed by iCCP / sRGB, which take precedence over gAMA).
 */
function bakeExponent(info: PngInfo): number | null {
  if (info.icc || info.srgb || !info.gamma) return null
  return Math.abs(info.gamma * 2.2 - 1) > SRGB_GAMMA_TOLERANCE ? 1 / info.gamma : null
}

/** The sRGB opto-electronic transfer function (IEC 61966-2-1): linear light → encoded value. */
const srgbOetf = (l: number): number =>
  l <= 0.0031308 ? 12.92 * l : 1.055 * Math.pow(l, 1 / 2.4) - 0.055

/**
 * Re-encode a gAMA-encoded value v ∈ [0, 1] as sRGB, as Chromium displays it: decode to linear
 * light with v^(1/g), then apply the sRGB OETF.
 */
const bakeValue = (v: number, dec: number): number => srgbOetf(Math.pow(v, dec))

/** Bake gamma into every colour sample of an 8- or 16-bit raster `r` (in place, via a LUT). */
function bakeGamma(r: Raster, rows: number, depth: number, dec: number): void {
  const rowLen = r.stride + 1
  if (depth === 16) {
    const lut = new Uint16Array(65536)
    for (let v = 0; v < 65536; v++) lut[v] = Math.round(65535 * bakeValue(v / 65535, dec))
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
  if (depth !== 8) fail(`cannot bake gamma into ${depth}-bit samples`) // sub-byte gray is indexed
  const lut = bakedLookup(8, dec)
  for (let y = 0; y < rows; y++) {
    const d = y * rowLen + 1
    for (let i = 0; i < r.stride; i++) r.data[d + i] = lut[r.data[d + i]]
  }
}

/** The 8-bit baked output of each of the 2^depth input levels. */
function bakedLookup(depth: number, dec: number): Uint8Array {
  const max = (1 << depth) - 1
  return Uint8Array.from({ length: max + 1 }, (_, v) => Math.round(255 * bakeValue(v / max, dec)))
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
  /** The colour space of the samples — or, with `lookup`, the base of an /Indexed space. */
  space: 'gray' | 'rgb'
  /** /Indexed lookup (PLTE, or a baked gray ramp): 1 or 3 bytes per entry, per `space`. */
  lookup?: Uint8Array
  icc?: PngInfo['icc']
  smask?: { data: Uint8Array; bitDepth: number }
  /** True when `data` is the original IDAT, untouched. */
  passthrough: boolean
}

export function planPng(bytes: Uint8Array): ImagePlan {
  const info = parsePng(bytes)
  const { width, height, bitDepth, colorType } = info
  const dec = bakeExponent(info)
  const samples = CHANNELS[colorType]
  const hasAlphaChannel = colorType === 4 || colorType === 6
  const space = colorType === 0 || colorType === 4 ? 'gray' : 'rgb'

  // Gamma lands in a lookup where there is one: palettes bake their PLTE entries, and gray below
  // 8 bits indexes its original samples into a baked 8-bit ramp — requantising the baked values
  // back to 1/2/4 bits would collapse levels (2-bit 0,1,2,3 → 0,170,170,255 instead of the
  // 0,156,213,255 Chromium shows for a linear gAMA).
  let lookup = info.palette
  if (lookup && dec !== null) lookup = lookup.map((v) => Math.round(255 * bakeValue(v / 255, dec)))
  if (colorType === 0 && bitDepth < 8 && dec !== null) lookup = bakedLookup(bitDepth, dec)
  const bakeSamples = dec !== null && !lookup

  const base = { width, height, bitDepth, space, lookup, icc: info.icc } as const
  let raster: Raster | undefined
  if (!info.interlaced && !hasAlphaChannel && !bakeSamples) {
    // Pass the IDAT through — unless it carries data past the image, which would bloat the PDF.
    const stride = rowBytes(width, samples, bitDepth)
    if (!trnsMatters(info)) {
      const { trailing } = inflateIdat(info.idat, height * (stride + 1), stride + 1, false)
      if (!trailing) return { ...base, colors: samples, data: info.idat, passthrough: true }
    } else {
      const decoded = decodeRaster(info)
      raster = decoded.raster
      if (!decoded.trailing) {
        const mask = trnsMask(raster, info)
        return {
          ...base,
          colors: samples,
          data: info.idat,
          passthrough: true,
          smask: mask ? { data: encodeRaster(mask, height, 1, 8), bitDepth: 8 } : undefined
        }
      }
    }
  }

  raster ??= decodeRaster(info).raster
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
  if (bakeSamples) bakeGamma(color, height, bitDepth, dec)
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
  if (plan.lookup) {
    const lut = plan.lookup
    let hex = ''
    for (const b of lut) hex += b.toString(16).padStart(2, '0')
    const hival = lut.length / (plan.space === 'gray' ? 1 : 3) - 1
    colorSpace = context.obj(['Indexed', baseSpace, hival, PDFHexString.of(hex)])
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
