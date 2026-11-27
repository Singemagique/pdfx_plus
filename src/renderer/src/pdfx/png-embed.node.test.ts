import { unzlibSync, zlibSync } from 'fflate'
import {
  PDFArray,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  type PDFDict,
  type PDFImage
} from 'pdf-lib'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { createFlattenResources } from './flatten'
import { imageToPdf } from './images'
import { embedPngFaithful } from './png-embed'
import { loadTestPdfium, withDoc, type TextPdfium } from '../test-utils/pdfium'

// ---------------------------------------------------------------------------------------------
// A tiny PNG encoder, so every colour type / depth / interlace combination is built in-test.

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const ascii = (s: string): Uint8Array => Uint8Array.from(s, (ch) => ch.charCodeAt(0))
const be32 = (v: number): number[] => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]

function chunk(type: string, data: Uint8Array): Uint8Array {
  const td = new Uint8Array([...ascii(type), ...data])
  return new Uint8Array([...be32(data.length), ...td, ...be32(crc32(td))])
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

/** Pack one row of samples at `depth` bits. */
function packRow(samples: number[], depth: number): number[] {
  const out = new Array<number>(Math.ceil((samples.length * depth) / 8)).fill(0)
  samples.forEach((v, i) => {
    if (depth === 16) {
      out[2 * i] = v >> 8
      out[2 * i + 1] = v & 255
    } else if (depth === 8) out[i] = v
    else {
      const bit = i * depth
      out[bit >> 3] |= v << (8 - depth - (bit & 7))
    }
  })
  return out
}

/** Forward PNG filter `f` of `row` given the previous (unfiltered) row. */
function filterRow(f: number, row: number[], prev: number[] | null, bpp: number): number[] {
  return row.map((x, i) => {
    const a = i >= bpp ? row[i - bpp] : 0
    const b = prev ? prev[i] : 0
    const c = prev && i >= bpp ? prev[i - bpp] : 0
    let pr = 0
    if (f === 1) pr = a
    else if (f === 2) pr = b
    else if (f === 3) pr = (a + b) >> 1
    else if (f === 4) {
      const pa = Math.abs(b - c)
      const pb = Math.abs(a - c)
      const pc = Math.abs(a + b - 2 * c)
      pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
    }
    return (x - pr) & 255
  })
}

/** Filtered scanlines (cycling through all five filter types) for a w×h block of pixels. */
function scanlines(
  w: number,
  h: number,
  depth: number,
  ct: number,
  px: (x: number, y: number) => number[]
): number[] {
  const bpp = Math.max(1, (CHANNELS[ct] * depth) >> 3)
  const out: number[] = []
  let prev: number[] | null = null
  for (let y = 0; y < h; y++) {
    const row = packRow(Array.from({ length: w }, (_, x) => px(x, y)).flat(), depth)
    const f = y % 5
    out.push(f, ...filterRow(f, row, prev, bpp))
    prev = row
  }
  return out
}

const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2]
]

interface PngSpec {
  width: number
  height: number
  colorType: number
  bitDepth: number
  /** Samples (including alpha / palette index) of pixel (x, y). */
  px: (x: number, y: number) => number[]
  interlace?: boolean
  /** Ancillary chunks placed before IDAT, in order. */
  chunks?: [string, Uint8Array][]
  /** Split the zlib stream across this many IDAT chunks. */
  idatParts?: number
}

function makePng(s: PngSpec): { png: Uint8Array; idat: Uint8Array } {
  let raw: number[]
  if (!s.interlace) raw = scanlines(s.width, s.height, s.bitDepth, s.colorType, s.px)
  else {
    raw = []
    for (const [x0, y0, dx, dy] of ADAM7) {
      const w = Math.ceil((s.width - x0) / dx)
      const h = Math.ceil((s.height - y0) / dy)
      if (w <= 0 || h <= 0) continue
      raw.push(
        ...scanlines(w, h, s.bitDepth, s.colorType, (x, y) => s.px(x0 + x * dx, y0 + y * dy))
      )
    }
  }
  const idat = zlibSync(new Uint8Array(raw))
  const ihdr = new Uint8Array([
    ...be32(s.width),
    ...be32(s.height),
    s.bitDepth,
    s.colorType,
    0,
    0,
    s.interlace ? 1 : 0
  ])
  const parts: Uint8Array[] = []
  const n = s.idatParts ?? 1
  const step = Math.ceil(idat.length / n)
  for (let i = 0; i < idat.length; i += step) parts.push(chunk('IDAT', idat.subarray(i, i + step)))
  const all = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    ...(s.chunks ?? []).map(([t, d]) => chunk(t, d)),
    ...parts,
    chunk('IEND', new Uint8Array(0))
  ]
  const png = new Uint8Array(all.reduce((k, a) => k + a.length, 0))
  let o = 0
  for (const a of all) {
    png.set(a, o)
    o += a.length
  }
  return { png, idat }
}

// Deterministic "photo-ish" content: smooth gradients plus a little hash noise.
const noise = (x: number, y: number, k: number): number =>
  (((x * 73856093) ^ (y * 19349663) ^ (k * 83492791)) >>> 0) % 17
const rgb8 = (x: number, y: number): number[] => [
  (x * 7 + noise(x, y, 0)) & 255,
  (y * 9 + noise(x, y, 1)) & 255,
  ((x + y) * 5 + noise(x, y, 2)) & 255
]

// ---------------------------------------------------------------------------------------------
// Inspection helpers.

const stream = (doc: PDFDocument, ref: PDFRef): PDFRawStream => {
  const s = doc.context.lookup(ref)
  if (!(s instanceof PDFRawStream)) throw new Error('not a raw stream')
  return s
}
const num = (d: PDFDict, key: string): number => (d.get(PDFName.of(key)) as PDFNumber).asNumber()
const nameOf = (d: PDFDict, key: string): string | undefined => d.get(PDFName.of(key))?.toString()

async function embedOne(png: Uint8Array): Promise<{ doc: PDFDocument; image: PDFImage }> {
  const doc = await PDFDocument.create()
  const image = await embedPngFaithful(doc, png)
  return { doc, image }
}

async function pagePdf(
  png: Uint8Array,
  embed: (doc: PDFDocument, png: Uint8Array) => Promise<PDFImage>
): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const image = await embed(doc, png)
  const page = doc.addPage([image.width, image.height])
  page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height })
  return doc.save()
}

// ---------------------------------------------------------------------------------------------
// PDFium render verification.

interface RenderPdfium extends TextPdfium {
  FPDFBitmap_Create(width: number, height: number, alpha: number): number
  FPDFBitmap_FillRect(bmp: number, l: number, t: number, w: number, h: number, c: number): boolean
  FPDFBitmap_GetBuffer(bmp: number): number
  FPDFBitmap_GetStride(bmp: number): number
  FPDFBitmap_Destroy(bmp: number): void
  FPDF_RenderPageBitmap(
    bmp: number,
    page: number,
    x: number,
    y: number,
    w: number,
    h: number,
    rotate: number,
    flags: number
  ): void
}

let pdfium: RenderPdfium

beforeAll(async () => {
  pdfium = await loadTestPdfium<RenderPdfium>()
})

/** Render page 0 at 1 px per point on white; returns packed RGB rows. */
function render(pdf: Uint8Array, w: number, h: number): Uint8Array {
  return withDoc(pdfium, pdf, (doc) => {
    const rt = pdfium.pdfium
    const page = pdfium.FPDF_LoadPage(doc, 0)
    const bmp = pdfium.FPDFBitmap_Create(w, h, 0)
    pdfium.FPDFBitmap_FillRect(bmp, 0, 0, w, h, 0xffffffff)
    pdfium.FPDF_RenderPageBitmap(bmp, page, 0, 0, w, h, 0, 0)
    const buf = pdfium.FPDFBitmap_GetBuffer(bmp)
    const stride = pdfium.FPDFBitmap_GetStride(bmp)
    const out = new Uint8Array(w * h * 3)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = buf + y * stride + x * 4
        const t = (y * w + x) * 3
        out[t] = rt.HEAPU8[o + 2]
        out[t + 1] = rt.HEAPU8[o + 1]
        out[t + 2] = rt.HEAPU8[o]
      }
    }
    pdfium.FPDFBitmap_Destroy(bmp)
    pdfium.FPDF_ClosePage(page)
    return out
  })
}

const maxDiff = (a: Uint8Array, b: Uint8Array): number => {
  let m = 0
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]))
  return m
}

const viaPdfLib = (doc: PDFDocument, png: Uint8Array): Promise<PDFImage> => doc.embedPng(png)

afterEach(() => vi.restoreAllMocks())

// ---------------------------------------------------------------------------------------------

describe('embedPngFaithful', () => {
  it('passes an 8-bit RGB IDAT straight through with PNG predictor DecodeParms', async () => {
    const { png, idat } = makePng({
      width: 20,
      height: 9,
      colorType: 2,
      bitDepth: 8,
      px: rgb8,
      idatParts: 3
    })
    const { doc, image } = await embedOne(png)
    const s = stream(doc, image.ref)
    expect([image.width, image.height]).toEqual([20, 9])
    expect(s.getContents()).toEqual(idat) // byte-identical to the concatenated IDAT payloads
    expect(nameOf(s.dict, 'ColorSpace')).toBe('/DeviceRGB')
    expect(num(s.dict, 'BitsPerComponent')).toBe(8)
    expect(nameOf(s.dict, 'Filter')).toBe('/FlateDecode')
    const parms = s.dict.get(PDFName.of('DecodeParms')) as PDFDict
    expect([num(parms, 'Predictor'), num(parms, 'Colors'), num(parms, 'BitsPerComponent'), num(parms, 'Columns')]).toEqual([15, 3, 8, 20]) // prettier-ignore
    expect(s.dict.get(PDFName.of('SMask'))).toBeUndefined()
  })

  it('keeps 16 bits per component', async () => {
    const { png, idat } = makePng({
      width: 6,
      height: 5,
      colorType: 2,
      bitDepth: 16,
      px: (x, y) => [x * 9000 + y, y * 12000 + 7, 65535 - x * 300]
    })
    const { doc, image } = await embedOne(png)
    const s = stream(doc, image.ref)
    expect(num(s.dict, 'BitsPerComponent')).toBe(16)
    expect(num(s.dict.get(PDFName.of('DecodeParms')) as PDFDict, 'BitsPerComponent')).toBe(16)
    expect(s.getContents()).toEqual(idat)
  })

  it.each([1, 2, 4, 8, 16])('keeps %i-bit grayscale as DeviceGray (not RGB)', async (depth) => {
    const max = (1 << depth) - 1
    const { png, idat } = makePng({
      width: 11,
      height: 4,
      colorType: 0,
      bitDepth: depth,
      px: (x, y) => [(x * 3 + y) % (max + 1)]
    })
    const { doc, image } = await embedOne(png)
    const s = stream(doc, image.ref)
    expect(nameOf(s.dict, 'ColorSpace')).toBe('/DeviceGray')
    expect(num(s.dict, 'BitsPerComponent')).toBe(depth)
    expect(num(s.dict.get(PDFName.of('DecodeParms')) as PDFDict, 'Colors')).toBe(1)
    expect(s.getContents()).toEqual(idat)
  })

  it('maps a palette with tRNS to /Indexed plus an SMask of the entry alphas', async () => {
    const plte = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 10, 20, 30])
    const trns = new Uint8Array([0, 128]) // entry 0 transparent, 1 half, 2–3 opaque (implicit)
    const { png, idat } = makePng({
      width: 9,
      height: 3,
      colorType: 3,
      bitDepth: 2,
      px: (x) => [x % 4],
      chunks: [
        ['PLTE', plte],
        ['tRNS', trns]
      ]
    })
    const { doc, image } = await embedOne(png)
    const s = stream(doc, image.ref)
    expect(s.getContents()).toEqual(idat) // indices pass through
    expect(num(s.dict, 'BitsPerComponent')).toBe(2)
    const cs = s.dict.get(PDFName.of('ColorSpace')) as PDFArray
    expect(cs.get(0).toString()).toBe('/Indexed')
    expect(cs.get(1).toString()).toBe('/DeviceRGB')
    expect((cs.get(2) as PDFNumber).asNumber()).toBe(3)
    expect((cs.get(3) as PDFHexString).asBytes()).toEqual(plte)
    const mask = stream(doc, s.dict.get(PDFName.of('SMask')) as PDFRef)
    expect([num(mask.dict, 'Width'), num(mask.dict, 'Height')]).toEqual([9, 3])
    expect(nameOf(mask.dict, 'ColorSpace')).toBe('/DeviceGray')
    expect(unzlibSync(mask.getContents()).length).toBe(3 * (9 + 1)) // predictor rows: filter byte + 9
    const pdf = await pagePdf(png, embedPngFaithful)
    // Over white: transparent red index → white; half-transparent green → light green; blue opaque.
    const px = render(pdf, 9, 3)
    expect(Array.from(px.subarray(0, 3))).toEqual([255, 255, 255])
    expect(px[3 + 1]).toBe(255)
    expect(px[3]).toBeGreaterThan(110)
    expect(px[3]).toBeLessThan(145)
    expect(Array.from(px.subarray(6, 9))).toEqual([0, 0, 255])
  })

  it('ignores an all-opaque palette tRNS (no SMask)', async () => {
    const { png } = makePng({
      width: 4,
      height: 2,
      colorType: 3,
      bitDepth: 8,
      px: (x) => [x % 2],
      chunks: [
        ['PLTE', new Uint8Array([1, 2, 3, 4, 5, 6])],
        ['tRNS', new Uint8Array([255, 255])]
      ]
    })
    const { doc, image } = await embedOne(png)
    expect(stream(doc, image.ref).dict.get(PDFName.of('SMask'))).toBeUndefined()
  })

  it('splits RGBA into RGB + an SMask with the image dimensions', async () => {
    const { png } = makePng({
      width: 13,
      height: 7,
      colorType: 6,
      bitDepth: 8,
      px: (x, y) => [...rgb8(x, y), (x * 20 + y * 3) & 255]
    })
    const { doc, image } = await embedOne(png)
    const s = stream(doc, image.ref)
    expect(nameOf(s.dict, 'ColorSpace')).toBe('/DeviceRGB')
    expect(num(s.dict.get(PDFName.of('DecodeParms')) as PDFDict, 'Colors')).toBe(3)
    const mask = stream(doc, s.dict.get(PDFName.of('SMask')) as PDFRef)
    expect([num(mask.dict, 'Width'), num(mask.dict, 'Height')]).toEqual([13, 7])
    expect(num(mask.dict, 'BitsPerComponent')).toBe(8)
    expect(nameOf(mask.dict, 'ColorSpace')).toBe('/DeviceGray')
  })

  it('drops the SMask of a fully opaque RGBA image', async () => {
    const { png } = makePng({ width: 5, height: 5, colorType: 6, bitDepth: 8, px: (x, y) => [...rgb8(x, y), 255] }) // prettier-ignore
    const { doc, image } = await embedOne(png)
    expect(stream(doc, image.ref).dict.get(PDFName.of('SMask'))).toBeUndefined()
  })

  it('keeps 16-bit alpha as a 16-bit SMask', async () => {
    const { png } = makePng({
      width: 6,
      height: 4,
      colorType: 4,
      bitDepth: 16,
      px: (x, y) => [x * 10000, y * 20000 + 1]
    })
    const { doc, image } = await embedOne(png)
    const s = stream(doc, image.ref)
    expect(nameOf(s.dict, 'ColorSpace')).toBe('/DeviceGray')
    expect(num(s.dict, 'BitsPerComponent')).toBe(16)
    const mask = stream(doc, s.dict.get(PDFName.of('SMask')) as PDFRef)
    expect(num(mask.dict, 'BitsPerComponent')).toBe(16)
  })

  it.each([
    [2, 8, rgb8],
    [0, 1, (x: number, y: number): number[] => [(x ^ y) & 1]],
    [0, 4, (x: number, y: number): number[] => [(x * 5 + y) & 15]],
    [6, 8, (x: number, y: number): number[] => [...rgb8(x, y), (x * 17) & 255]]
  ])(
    'decodes Adam7-interlaced (type %i, %i-bit) to the same render as non-interlaced',
    async (ct, depth, px) => {
      const spec = { width: 19, height: 11, colorType: ct, bitDepth: depth, px }
      const flat = makePng(spec).png
      const inter = makePng({ ...spec, interlace: true }).png
      const { doc, image } = await embedOne(inter)
      const s = stream(doc, image.ref)
      expect(num(s.dict, 'BitsPerComponent')).toBe(depth)
      const a = render(await pagePdf(flat, embedPngFaithful), 19, 11)
      const b = render(await pagePdf(inter, embedPngFaithful), 19, 11)
      expect(maxDiff(a, b)).toBe(0)
    }
  )

  it('emits iCCP as an ICCBased colour space carrying the profile bytes and /N', async () => {
    const profile = new Uint8Array(300).map((_, i) => (i * 31) & 255)
    profile.set(ascii('mntr'), 12)
    profile.set(ascii('RGB '), 16)
    profile.set(ascii('XYZ '), 20)
    profile.set(ascii('acsp'), 36)
    const iccp = new Uint8Array([...ascii('Test profile'), 0, 0, ...zlibSync(profile)])
    const { png } = makePng({ width: 8, height: 8, colorType: 2, bitDepth: 8, px: rgb8, chunks: [['iCCP', iccp]] }) // prettier-ignore
    const { doc, image } = await embedOne(png)
    const cs = stream(doc, image.ref).dict.get(PDFName.of('ColorSpace')) as PDFArray
    expect(cs.get(0).toString()).toBe('/ICCBased')
    const icc = stream(doc, cs.get(1) as PDFRef)
    expect(num(icc.dict, 'N')).toBe(3)
    expect(nameOf(icc.dict, 'Alternate')).toBe('/DeviceRGB')
    expect(unzlibSync(icc.getContents())).toEqual(profile)
  })

  it('uses a grayscale profile (N 1) as the base of an iCCP gray image', async () => {
    const profile = new Uint8Array(200)
    profile.set(ascii('GRAY'), 16)
    const iccp = new Uint8Array([...ascii('g'), 0, 0, ...zlibSync(profile)])
    const { png } = makePng({ width: 4, height: 4, colorType: 0, bitDepth: 8, px: (x) => [x * 60], chunks: [['iCCP', iccp]] }) // prettier-ignore
    const { doc, image } = await embedOne(png)
    const cs = stream(doc, image.ref).dict.get(PDFName.of('ColorSpace')) as PDFArray
    expect(num(stream(doc, cs.get(1) as PDFRef).dict, 'N')).toBe(1)
  })

  it('ignores an iCCP whose colour space does not match the image (RGB profile on gray)', async () => {
    const profile = new Uint8Array(200)
    profile.set(ascii('RGB '), 16)
    const iccp = new Uint8Array([...ascii('x'), 0, 0, ...zlibSync(profile)])
    const { png } = makePng({ width: 4, height: 4, colorType: 0, bitDepth: 8, px: (x) => [x], chunks: [['iCCP', iccp]] }) // prettier-ignore
    const { doc, image } = await embedOne(png)
    expect(nameOf(stream(doc, image.ref).dict, 'ColorSpace')).toBe('/DeviceGray')
  })

  it('bakes a non-sRGB gAMA into the samples (linear gAMA 1.0 → V^(1/2.2))', async () => {
    const gama = new Uint8Array(be32(100000)) // gamma 1.0
    const { png } = makePng({ width: 4, height: 1, colorType: 0, bitDepth: 8, px: (x) => [x * 64], chunks: [['gAMA', gama]] }) // prettier-ignore
    const px = render(await pagePdf(png, embedPngFaithful), 4, 1)
    const want = [0, 64, 128, 192].map((v) => Math.round(255 * Math.pow(v / 255, 1 / 2.2)))
    expect([px[0], px[3], px[6], px[9]]).toEqual(want)
  })

  it('leaves sRGB-like gAMA (and an sRGB chunk) as plain passthrough', async () => {
    const { png, idat } = makePng({
      width: 4,
      height: 2,
      colorType: 2,
      bitDepth: 8,
      px: rgb8,
      chunks: [
        ['sRGB', new Uint8Array([0])],
        ['gAMA', new Uint8Array(be32(45455))]
      ]
    })
    const { doc, image } = await embedOne(png)
    const s = stream(doc, image.ref)
    expect(nameOf(s.dict, 'ColorSpace')).toBe('/DeviceRGB')
    expect(s.getContents()).toEqual(idat)
  })

  it('turns an RGB tRNS colour key into an SMask (colour still passes through)', async () => {
    const { png, idat } = makePng({
      width: 3,
      height: 1,
      colorType: 2,
      bitDepth: 8,
      px: (x) => (x === 1 ? [10, 20, 30] : [200, 0, 0]),
      chunks: [['tRNS', new Uint8Array([0, 10, 0, 20, 0, 30])]]
    })
    const { doc, image } = await embedOne(png)
    expect(stream(doc, image.ref).getContents()).toEqual(idat)
    const px = render(await pagePdf(png, embedPngFaithful), 3, 1)
    expect(Array.from(px)).toEqual([200, 0, 0, 255, 255, 255, 200, 0, 0])
  })

  it('falls back to pdf-lib (warning once) on a PNG it cannot handle', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const doc = await PDFDocument.create()
    const sentinel = {} as PDFImage
    const embedPng = vi.spyOn(doc, 'embedPng').mockResolvedValue(sentinel)
    const { png } = makePng({ width: 2, height: 2, colorType: 2, bitDepth: 8, px: rgb8 })
    const broken = png.slice()
    broken[28] = 2 // IHDR interlace method 2 does not exist
    expect(await embedPngFaithful(doc, broken)).toBe(sentinel)
    expect(await embedPngFaithful(doc, broken.subarray(0, 40))).toBe(sentinel) // truncated
    expect(embedPng).toHaveBeenCalledTimes(2)
    expect(warn.mock.calls.length).toBeLessThanOrEqual(1)
  })

  it('falls back when the IDAT is shorter than the image needs', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const doc = await PDFDocument.create()
    const embedPng = vi.spyOn(doc, 'embedPng').mockResolvedValue({} as PDFImage)
    const small = makePng({ width: 4, height: 2, colorType: 2, bitDepth: 8, px: rgb8 }).png
    // Patch IHDR height 2 → 50 (CRC is not checked by the parser, as in pdf-lib).
    small[23] = 50
    await embedPngFaithful(doc, small)
    expect(embedPng).toHaveBeenCalledTimes(1)
  })
})

describe('export paths use the faithful embedder', () => {
  const gray = (): Uint8Array =>
    makePng({ width: 5, height: 3, colorType: 0, bitDepth: 8, px: (x) => [x * 50] }).png

  it('flatten: an image/png attachment embeds as DeviceGray', async () => {
    const doc = await PDFDocument.create()
    const res = createFlattenResources(doc, new Map([['a', { bytes: gray(), mime: 'image/png' }]]))
    const image = await res.embedImage('a')
    expect(nameOf(stream(doc, image.ref).dict, 'ColorSpace')).toBe('/DeviceGray')
  })

  it('imageToPdf: an imported PNG keeps its colour model', async () => {
    const doc = await PDFDocument.load(await imageToPdf(gray()))
    const xobjects = doc.getPage(0).node.Resources()!.lookup(PDFName.of('XObject')) as PDFDict
    const ref = xobjects.get(xobjects.keys()[0]) as PDFRef
    expect(nameOf(stream(doc, ref).dict, 'ColorSpace')).toBe('/DeviceGray')
  })
})

describe('embedPngFaithful renders like pdf-lib embedPng (no regression)', () => {
  it.each([
    ['8-bit RGB', { width: 37, height: 23, colorType: 2, bitDepth: 8, px: rgb8 }],
    [
      'RGBA',
      {
        width: 37,
        height: 23,
        colorType: 6,
        bitDepth: 8,
        px: (x: number, y: number): number[] => [...rgb8(x, y), (x * 7 + y * 11) & 255]
      }
    ],
    ['8-bit gray', { width: 30, height: 10, colorType: 0, bitDepth: 8, px: (x: number, y: number): number[] => [(x * 8 + y) & 255] }], // prettier-ignore
    [
      'palette + tRNS',
      {
        width: 16,
        height: 8,
        colorType: 3,
        bitDepth: 4,
        px: (x: number, y: number): number[] => [(x + y) & 3],
        chunks: [
          ['PLTE', new Uint8Array([250, 10, 10, 10, 250, 10, 10, 10, 250, 90, 90, 90])],
          ['tRNS', new Uint8Array([0, 100, 200])]
        ] as [string, Uint8Array][]
      }
    ],
    [
      '16-bit RGBA',
      {
        width: 12,
        height: 9,
        colorType: 6,
        bitDepth: 16,
        px: (x: number, y: number): number[] => [
          x * 5000,
          y * 7000,
          40000,
          (x * 4000 + y * 1000) & 0xffff
        ]
      }
    ]
  ])('%s', async (_label, spec) => {
    const { png } = makePng(spec)
    const ours = await pagePdf(png, embedPngFaithful)
    const theirs = await pagePdf(png, viaPdfLib)
    const a = render(ours, spec.width, spec.height)
    const b = render(theirs, spec.width, spec.height)
    // 8-bit content is sample-identical; 16-bit and palette+alpha may differ by rounding only.
    expect(maxDiff(a, b)).toBeLessThanOrEqual(spec.bitDepth === 16 || spec.colorType === 3 ? 1 : 0)
  })

  it('renders 8-bit RGB and RGBA pixel-identically to embedPng', async () => {
    for (const ct of [2, 6]) {
      const spec = {
        width: 64,
        height: 48,
        colorType: ct,
        bitDepth: 8,
        px: (x: number, y: number): number[] =>
          ct === 2 ? rgb8(x, y) : [...rgb8(x, y), (x * 4 + y) & 255]
      }
      const { png } = makePng(spec)
      const a = render(await pagePdf(png, embedPngFaithful), 64, 48)
      const b = render(await pagePdf(png, viaPdfLib), 64, 48)
      expect(a.some((v) => v !== 255)).toBe(true) // the image actually rendered
      expect(maxDiff(a, b)).toBe(0)
    }
  })
})
