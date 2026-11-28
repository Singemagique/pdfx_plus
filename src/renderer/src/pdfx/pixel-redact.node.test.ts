// Sub-image (pixel) redaction (DESIGN.md §2 D3, PR12): pixel-redact.ts, pixel-redact-doc.ts and
// the PDFium pass in redact.ts, end to end. What is checked:
// - the decoded samples of the redacted copy: every sample the box touches is black, every other
//   one is byte-identical to the source; the copy keeps the source's depth and colour space, and
//   its stream is at most twice the source's (1-bit stays 1-bit);
// - a shared XObject: the other page's image is untouched and still the shared object;
// - no stream anywhere in the output still holds the covered pixels (a pixel needle oracle);
// - each out-of-scope case really falls back to whole-image removal;
// - rotated pages with offset MediaBox and CropBox (the frame mapping, checked against pdf.js's own
//   viewport); a rendered page against the source;
// - the export pipeline with an OCR layer: the image stays (not in `removed`), only the words under
//   the box go (rule 1), and both extractors and the raw-bytes oracle find nothing.

import type { PDFDocumentProxy } from 'pdfjs-dist'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { zlibSync } from 'fflate'
import jpeg from 'jpeg-js'
import {
  concatTransformationMatrix,
  decodePDFRawStream,
  degrees,
  drawObject,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFOperator,
  PDFRawStream,
  PDFRef,
  popGraphicsState,
  pushGraphicsState,
  StandardFonts,
  type PDFPage
} from 'pdf-lib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { loadNodeSynthDeps } from '../../../shared/ocr/test-utils/node-deps'
import {
  createPdfiumRasterizer,
  type Rasterizer
} from '../../../shared/ocr/test-utils/pdfium-raster'
import { synthesize, type SynthResult } from '../../../shared/ocr/test-utils/synth'
import { pack, wordFootprint } from '../../../shared/ocr/types'
import { makePageKey, type Overlay } from '../edit/model'
import { extractText, loadTestPdfium, type TextPdfium } from '../test-utils/pdfium'
import type { DocEntry, PageEntry } from '../types'
import { buildPdf, buildPdfx, type EditLayer } from './build'
import { withOcrLayer, type FrameBox } from './ocr-export'
import {
  blankSamples,
  blankValue,
  isAxisAligned,
  matchCandidate,
  MAX_GROWTH,
  pixelRect,
  type ImageCandidate,
  type Matrix
} from './pixel-redact'
import { imageCandidates, imagePlan, PixelSwapError, swapPixelImages } from './pixel-redact-doc'
import { redactPdfReport, type RedactRect, type RedactResult } from './redact'
import { applyRedactedBytes, buildRedactedSources, sanitizeRedacted } from './redact-export'
import { encodeG4 } from './test-utils/ccitt-g4'
import { extractorLeaks, rawLeaks } from './test-utils/leak-oracle'
import { ocrPageFromGt, pdfjsCopyText, pdfjsText, type ProbePdfium } from './test-utils/ocr-layer'

let pdfium: ProbePdfium
let raster: Rasterizer
let fax: SynthResult
let scan: SynthResult

beforeAll(async () => {
  pdfium = await loadTestPdfium<ProbePdfium>()
  raster = createPdfiumRasterizer(pdfium as never)
  const deps = await loadNodeSynthDeps()
  fax = await synthesize({ preset: 'fax200', seed: 3 }, deps)
  scan = await synthesize({ preset: 'clean300', seed: 11 }, deps)
})

// ---------------------------------------------------------------------------------------------
// Fixtures

/** A deterministic byte stream (LCG): noise no row of which repeats. */
function noise(n: number, seed: number): Uint8Array {
  let s = seed >>> 0
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    out[i] = s >>> 24
  }
  return out
}

type Dict = Record<string, unknown>

/** An image XObject stream (registered): `data` Flate-compressed unless `raw` is set. */
function imageStream(
  page: PDFPage,
  data: Uint8Array,
  w: number,
  h: number,
  dict: Dict,
  raw = false
): PDFRef {
  const ctx = page.doc.context
  const base = { Type: 'XObject', Subtype: 'Image', Width: w, Height: h, ...dict }
  const s = raw ? ctx.stream(data, base) : ctx.stream(zlibSync(data), { ...base, Filter: 'FlateDecode' }) // prettier-ignore
  return ctx.register(s as PDFRawStream)
}

/** Draw XObject `ref` on `page` with the image matrix `m`. */
function place(page: PDFPage, ref: PDFRef, m: Matrix, name = 'Im'): PDFName {
  const n = page.node.newXObject(name, ref)
  page.pushOperators(
    pushGraphicsState(),
    concatTransformationMatrix(...m),
    drawObject(n),
    popGraphicsState()
  )
  return n
}

const W = 120
const H = 80
/** The standard placement: 1 sample = 2 pt, the image's lower-left at (40, 60). */
const M: Matrix = [240, 0, 0, 160, 40, 60]
/** A box inside samples 30–59 × rows 20–39 (a quarter sample in from each edge). */
const BOX: RedactRect = { x: 100.5, y: 140.5, w: 59, h: 39 }
/** The samples BOX covers. */
const BOX_PX = { c0: 30, c1: 59, r0: 20, r1: 39 }

/** A one-page document with one image (placed by M) and nothing else. */
async function onePage(
  data: Uint8Array,
  dict: Dict,
  opts: { raw?: boolean; m?: Matrix; w?: number; h?: number } = {}
): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([400, 400])
  place(page, imageStream(page, data, opts.w ?? W, opts.h ?? H, dict, opts.raw), opts.m ?? M)
  return doc.save()
}

const gray8 = (seed = 1): Uint8Array => noise(W * H, seed)
const GRAY = { ColorSpace: 'DeviceGray', BitsPerComponent: 8 }

/** The candidate pre-pass, the PDFium pass and the pdf-lib pass on page `i`, as the export does. */
async function redactPixels(
  bytes: Uint8Array,
  rects: RedactRect[],
  i = 0
): Promise<{ r: RedactResult; out: Uint8Array }> {
  const pixels = await imageCandidates(bytes, [i])
  const r = redactPdfReport(pdfium, bytes, [{ pageIndex: i, rects }], { pixels })
  return { r, out: await sanitizeRedacted(r.bytes, [i], r.pixels) }
}

interface PageImage {
  ref: PDFRef
  dict: PDFDict
  stored: number
  samples: Uint8Array
}

/** The image XObjects page `i` of `bytes` lists, decoded. */
async function pageImages(bytes: Uint8Array, i = 0): Promise<PageImage[]> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false })
  const xo = doc.getPage(i).node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict)
  const out: PageImage[] = []
  for (const [, v] of xo?.entries() ?? []) {
    const s = doc.context.lookup(v)
    if (!(v instanceof PDFRef) || !(s instanceof PDFRawStream)) continue
    if (s.dict.get(PDFName.of('Subtype')) !== PDFName.of('Image')) continue
    out.push({ ref: v, dict: s.dict, stored: s.contents.length, samples: decodePDFRawStream(s).decode() }) // prettier-ignore
  }
  return out
}

const num = (d: PDFDict, k: string): number | undefined =>
  (d.get(PDFName.of(k)) as PDFNumber | undefined)?.asNumber()

/**
 * Every stream of `bytes` whose decoded data contains `needle` (the covered pixels of a fixture):
 * the pixel half of the leak oracle.
 */
async function pixelLeaks(bytes: Uint8Array, needle: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true })
  const hits: string[] = []
  const n = Buffer.from(needle)
  for (const [ref, o] of doc.context.enumerateIndirectObjects()) {
    if (!(o instanceof PDFRawStream)) continue
    let data: Uint8Array
    try {
      data = decodePDFRawStream(o).decode()
    } catch {
      data = o.contents
    }
    if (Buffer.from(data.buffer, data.byteOffset, data.byteLength).indexOf(n) >= 0)
      hits.push(ref.toString())
  }
  return hits
}

/** Row `r`, samples c0..c1 (inclusive), of packed rows of `stride` bytes at 8 bits × nc. */
const rowBytes = (s: Uint8Array, stride: number, r: number, from: number, to: number): Uint8Array =>
  s.slice(r * stride + from, r * stride + to)

/**
 * Every sample of a W × H image (packed at `bpc`, `nc` components) inside the inclusive rect is
 * `blank`, and every other one equals `src`'s.
 */
function expectBlanked(
  got: Uint8Array,
  src: Uint8Array,
  rect: { c0: number; r0: number; c1: number; r1: number },
  opts: { w?: number; h?: number; nc?: number; bpc?: number; blank?: number } = {}
): void {
  const { w = W, h = H, nc = 1, bpc = 8, blank = 0 } = opts
  const stride = Math.ceil((w * nc * bpc) / 8)
  expect(got.length).toBe(stride * h)
  const at = (s: Uint8Array, r: number, k: number): number => {
    const bit = k * bpc
    return (s[r * stride + (bit >> 3)] >> (8 - bpc - (bit & 7))) & ((1 << bpc) - 1)
  }
  let inside = 0
  let changedOutside = 0
  let notBlank = 0
  for (let r = 0; r < h; r++)
    for (let k = 0; k < w * nc; k++) {
      const c = Math.floor(k / nc)
      const isIn = r >= rect.r0 && r <= rect.r1 && c >= rect.c0 && c <= rect.c1
      if (isIn) {
        inside++
        if (at(got, r, k) !== blank) notBlank++
      } else if (at(got, r, k) !== at(src, r, k)) changedOutside++
    }
  expect(inside).toBe((rect.r1 - rect.r0 + 1) * (rect.c1 - rect.c0 + 1) * nc)
  expect({ notBlank, changedOutside }).toEqual({ notBlank: 0, changedOutside: 0 })
}

/** The covered samples of the standard BOX on a gray8 image: a needle no other row holds. */
const needleOf = (src: Uint8Array, stride = W, r = 25, from = 32, to = 56): Uint8Array =>
  rowBytes(src, stride, r, from, to)

// ---------------------------------------------------------------------------------------------
// The pure half

describe('pixelRect: the conservative mapping', () => {
  it('a box inside samples takes them; one exactly on sample edges takes the neighbours too', () => {
    expect(pixelRect(M, W, H, BOX)).toEqual(BOX_PX)
    // The outward epsilon (float32 matrices): an edge never decides against blanking.
    expect(pixelRect(M, W, H, { x: 100, y: 140, w: 60, h: 40 })).toEqual({ c0: 29, c1: 60, r0: 19, r1: 40 }) // prettier-ignore
  })

  it('a box inside one sample, or across an edge by a hair, takes every sample it touches', () => {
    // Inside sample (10, 70) (x 60–62, y 60–62 user space: the bottom row is row 79).
    expect(pixelRect(M, W, H, { x: 60.5, y: 60.5, w: 1, h: 1 })).toEqual({ c0: 10, c1: 10, r0: 79, r1: 79 }) // prettier-ignore
    // 0.01 pt past an edge on every side: one more sample each way.
    expect(pixelRect(M, W, H, { x: 99.99, y: 139.99, w: 60.02, h: 40.02 })).toEqual({ c0: 29, c1: 60, r0: 19, r1: 40 }) // prettier-ignore
  })

  it('mirrored and half-turned placements, clamping, and a miss', () => {
    // a < 0: column 0 at the right edge (x = 280).
    const mx: Matrix = [-240, 0, 0, 160, 280, 60]
    expect(pixelRect(mx, W, H, BOX)).toEqual({ c0: 60, c1: 89, r0: 20, r1: 39 })
    // d < 0: row 0 at the bottom (y = 60).
    const my: Matrix = [240, 0, 0, -160, 40, 220]
    expect(pixelRect(my, W, H, BOX)).toEqual({ c0: 30, c1: 59, r0: 40, r1: 59 })
    // Half turn: both.
    const m180: Matrix = [-240, 0, 0, -160, 280, 220]
    expect(pixelRect(m180, W, H, BOX)).toEqual({ c0: 60, c1: 89, r0: 40, r1: 59 })
    expect(pixelRect(M, W, H, { x: 0, y: 0, w: 1000, h: 1000 })).toEqual({ c0: 0, c1: W - 1, r0: 0, r1: H - 1 }) // prettier-ignore
    expect(pixelRect(M, W, H, { x: 0, y: 0, w: 39.9, h: 400 })).toBeNull()
  })

  it('isAxisAligned: no quarter turn, no skew, no rotation however small', () => {
    expect(isAxisAligned(M)).toBe(true)
    expect(isAxisAligned([-240, 0, 0, -160, 1, 2])).toBe(true)
    expect(isAxisAligned([0, 160, -240, 0, 1, 2])).toBe(false) // 90°
    expect(isAxisAligned([240, 0, 10, 160, 1, 2])).toBe(false) // skew
    const t = (1 * Math.PI) / 180
    expect(isAxisAligned([240 * Math.cos(t), 240 * Math.sin(t), -160 * Math.sin(t), 160 * Math.cos(t), 0, 0])).toBe(false) // prettier-ignore
    expect(isAxisAligned([240, 1e-5, 0, 160, 0, 0])).toBe(true) // float32 noise
    expect(isAxisAligned([0, 0, 0, 160, 0, 0])).toBe(false)
    expect(isAxisAligned([NaN, 0, 0, 160, 0, 0])).toBe(false)
  })
})

describe('blankSamples and blankValue', () => {
  it('blanks at 1, 2, 4 and 8 bits and three components, nothing else', () => {
    for (const bpc of [1, 2, 4, 8])
      for (const nc of [1, 3]) {
        const w = 13
        const h = 5
        const stride = Math.ceil((w * nc * bpc) / 8)
        const src = noise(stride * h, bpc * 10 + nc)
        const got = src.slice()
        const rect = { c0: 3, c1: 9, r0: 1, r1: 3 }
        blankSamples(got, w, nc, bpc, [rect], 0)
        expectBlanked(got, src, rect, { w, h, nc, bpc })
      }
  })

  it('an Indexed palette blanks with its darkest entry; Gray and RGB with 0', () => {
    const lookup = Uint8Array.from([255, 0, 0, 0, 0, 255, 3, 3, 3, 200, 200, 200])
    expect(blankValue({ kind: 'Indexed', base: 'DeviceRGB', hival: 3, lookup })).toBe(2)
    expect(blankValue({ kind: 'Indexed', base: 'DeviceGray', hival: 2, lookup: Uint8Array.from([9, 0, 4]) })).toBe(1) // prettier-ignore
    expect(blankValue({ kind: 'DeviceGray' })).toBe(0)
    expect(blankValue({ kind: 'DeviceRGB' })).toBe(0)
  })

  it('matchCandidate: by size and stored bytes; two disagreeing plans for one stream match none', () => {
    const raw = Uint8Array.from([1, 2, 3])
    const plan = { decode: 'samples', colorSpace: { kind: 'DeviceGray' }, bpc: 8 } as const
    const a: ImageCandidate = { width: 2, height: 2, raw, plan }
    expect(matchCandidate([a], 2, 2, Uint8Array.from([1, 2, 3]))).toBe(a)
    expect(matchCandidate([a], 2, 3, raw)).toBeNull()
    expect(matchCandidate([a], 2, 2, Uint8Array.from([1, 2, 4]))).toBeNull()
    expect(matchCandidate([a, { ...a, plan: { skip: 'Decode' } }], 2, 2, raw)).toBeNull()
    expect(matchCandidate([a, { ...a }], 2, 2, raw)).not.toBeNull()
  })
})

describe('imagePlan: the scope, read off the dictionary', () => {
  async function planOf(
    dict: Dict,
    extra?: (doc: PDFDocument) => Dict
  ): Promise<ReturnType<typeof imagePlan>> {
    // prettier-ignore
    const doc = await PDFDocument.create()
    const d = doc.context.obj({ Type: 'XObject', Subtype: 'Image', Width: 4, Height: 4, ...dict, ...(extra?.(doc) ?? {}) }) as PDFDict // prettier-ignore
    return imagePlan(doc.context, d)
  }
  const reason = async (dict: Dict, extra?: (doc: PDFDocument) => Dict): Promise<string> => {
    const p = await planOf(dict, extra)
    return 'skip' in p ? p.skip : 'in scope'
  }

  it('in scope: Gray, RGB and Indexed samples, CCITT, JBIG2 and DCT', async () => {
    expect(await planOf({ ...GRAY, Filter: 'FlateDecode' })).toEqual({ decode: 'samples', colorSpace: { kind: 'DeviceGray' }, bpc: 8 }) // prettier-ignore
    expect(await planOf({ ColorSpace: 'DeviceRGB', BitsPerComponent: 4, Filter: ['ASCIIHexDecode', 'FlateDecode'] })).toMatchObject({ decode: 'samples', bpc: 4 }) // prettier-ignore
    expect(await planOf({ ColorSpace: 'DeviceGray', BitsPerComponent: 1, Filter: 'CCITTFaxDecode' })).toEqual({ decode: 'bitmap', colorSpace: { kind: 'DeviceGray' }, bpc: 1 }) // prettier-ignore
    expect(await planOf({ ColorSpace: 'DeviceGray', Filter: 'JBIG2Decode' })).toMatchObject({ decode: 'bitmap', bpc: 1 }) // prettier-ignore
    expect(await planOf({ ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'DCTDecode' })).toMatchObject({ decode: 'bitmap', bpc: 8 }) // prettier-ignore
    const indexed = await planOf({ BitsPerComponent: 2 }, (doc) => ({ ColorSpace: doc.context.obj([PDFName.of('Indexed'), PDFName.of('DeviceRGB'), 1, doc.context.register(doc.context.stream(Uint8Array.from([1, 2, 3, 4, 5, 6])))]) })) // prettier-ignore
    expect(indexed).toEqual({ decode: 'samples', bpc: 2, colorSpace: { kind: 'Indexed', base: 'DeviceRGB', hival: 1, lookup: Uint8Array.from([1, 2, 3, 4, 5, 6]) } }) // prettier-ignore
  })

  it('out of scope: masks, Decode, OC, ICC and other colour spaces, JPX, 16 bits, odd filters', async () => {
    expect(await reason({ ...GRAY, ImageMask: true })).toBe('ImageMask')
    expect(await reason({ BitsPerComponent: 1, ImageMask: true })).toBe('ImageMask')
    expect(await reason({ ...GRAY, SMask: PDFRef.of(99) })).toBe('SMask')
    expect(await reason({ ...GRAY, Mask: [0, 10] })).toBe('Mask')
    expect(await reason({ ...GRAY, Decode: [0, 1] })).toBe('Decode')
    expect(await reason({ ...GRAY, OC: PDFRef.of(98) })).toBe('OC')
    expect(await reason({ ColorSpace: 'DeviceCMYK', BitsPerComponent: 8 })).toBe('colour space')
    expect(await reason({ BitsPerComponent: 8 })).toBe('colour space')
    expect(await reason({ BitsPerComponent: 8, ColorSpace: ['CalRGB', {}] })).toBe('colour space')
    expect(await reason({ BitsPerComponent: 8 }, (doc) => ({ ColorSpace: doc.context.obj([PDFName.of('ICCBased'), doc.context.register(doc.context.stream(new Uint8Array(4), { N: 1 }))]) }))).toBe('colour space') // prettier-ignore
    expect(await reason({ BitsPerComponent: 8 }, (doc) => ({ ColorSpace: doc.context.obj([PDFName.of('Indexed'), doc.context.obj([PDFName.of('ICCBased'), PDFRef.of(5)]), 1, doc.context.register(doc.context.stream(new Uint8Array(6)))]) }))).toBe('Indexed base colour space') // prettier-ignore
    expect(await reason({ ...GRAY, BitsPerComponent: 16 })).toBe('depth')
    expect(await reason({ ColorSpace: 'DeviceRGB', Filter: 'JPXDecode' })).toBe('filter JPXDecode')
    expect(await reason({ ...GRAY, Filter: 'Crypt' })).toBe('filter Crypt')
    expect(await reason({ ...GRAY, Filter: ['DCTDecode', 'FlateDecode'] })).toBe('filter DCTDecode not last') // prettier-ignore
    expect(await reason({ ColorSpace: 'DeviceRGB', BitsPerComponent: 1, Filter: 'CCITTFaxDecode' })).toBe('bilevel colour space') // prettier-ignore
  })
})

// ---------------------------------------------------------------------------------------------
// PDFium: the copy, its samples, its size

describe('an 8-bit DeviceGray image', () => {
  it('blanks exactly the covered samples on a new object; the rest is byte-identical', async () => {
    const src = gray8()
    const bytes = await onePage(src, GRAY)
    const { r, out } = await redactPixels(bytes, [BOX])
    expect(r.removed.get(0)).toEqual([]) // modified, not removed
    expect(r.pixels.get(0)).toHaveLength(1)
    expect(r.pixels.get(0)![0].rects).toEqual([BOX_PX])
    const [img, ...rest] = await pageImages(out)
    expect(rest).toEqual([])
    expect(img.dict.get(PDFName.of('ColorSpace'))).toBe(PDFName.of('DeviceGray'))
    expect(num(img.dict, 'BitsPerComponent')).toBe(8)
    expectBlanked(img.samples, src, BOX_PX)
    // Size: at most twice the source stream [measured: noise compresses to ~its own size].
    const [before] = await pageImages(bytes)
    expect(img.stored).toBeLessThanOrEqual(MAX_GROWTH * before.stored)
    // The covered samples are nowhere in the file; a control row outside the box still is.
    expect(await pixelLeaks(out, needleOf(src))).toEqual([])
    expect(await pixelLeaks(out, needleOf(src, W, 60))).toHaveLength(1)
  })

  it('a box over the image edge and a second box: both blanked, clamped to the image', async () => {
    const src = gray8(2)
    const bytes = await onePage(src, GRAY)
    const edge = { x: 0, y: 0, w: 50.5, h: 70.5 } // samples 0–5, rows 75–79
    const { r, out } = await redactPixels(bytes, [BOX, edge])
    expect(r.pixels.get(0)![0].rects).toEqual([BOX_PX, { c0: 0, c1: 5, r0: 74, r1: 79 }]) // prettier-ignore
    const [img] = await pageImages(out)
    const once = src.slice()
    blankSamples(once, W, 1, 8, [{ c0: 0, c1: 5, r0: 74, r1: 79 }], 0)
    expectBlanked(img.samples, once, BOX_PX)
  })

  it('keeps its place in the paint order: text drawn over the image still paints over it', async () => {
    const doc = await PDFDocument.create()
    const page = doc.addPage([400, 400])
    place(page, imageStream(page, new Uint8Array(W * H).fill(255), W, H, GRAY), M)
    const font = await doc.embedFont(StandardFonts.Helvetica)
    page.drawText('PUBLIC', { x: 50, y: 200, size: 30, font })
    const bytes = await doc.save()
    const { out } = await redactPixels(bytes, [{ x: 200, y: 70, w: 30, h: 30 }])
    // The word still renders where it did (it is above the image, so it would vanish under it).
    const a = raster(bytes, 72).data
    const b = raster(out, 72).data
    const rowOf = (y: number): number => 400 - y
    let diff = 0
    for (let y = rowOf(232); y < rowOf(195); y++)
      for (let x = 45; x < 160; x++) if (a[y * 400 + x] !== b[y * 400 + x]) diff++
    expect(diff).toBe(0)
    expect(extractText(pdfium as TextPdfium, out)).toBe('PUBLIC')
  })
})

describe('depths and colour spaces', () => {
  it.each([1, 2, 4])('%i-bit DeviceGray (Flate) keeps its depth', async (bpc) => {
    const stride = Math.ceil((W * bpc) / 8)
    const src = noise(stride * H, 5 + bpc)
    const bytes = await onePage(src, { ColorSpace: 'DeviceGray', BitsPerComponent: bpc })
    const { r, out } = await redactPixels(bytes, [BOX])
    expect(r.pixels.get(0)).toHaveLength(1)
    const [img] = await pageImages(out)
    expect(num(img.dict, 'BitsPerComponent')).toBe(bpc)
    expectBlanked(img.samples, src, BOX_PX, { bpc })
    const [before] = await pageImages(bytes)
    expect(img.stored).toBeLessThanOrEqual(MAX_GROWTH * before.stored)
    // Columns 32–55 of row 25: whole bytes inside the box.
    const from = (32 * bpc) / 8
    expect(await pixelLeaks(out, rowBytes(src, stride, 25, from, from + 3 * bpc))).toEqual([])
  })

  it.each([8, 4])('%i-bit DeviceRGB', async (bpc) => {
    const stride = Math.ceil((W * 3 * bpc) / 8)
    const src = noise(stride * H, 6 + bpc)
    const bytes = await onePage(src, { ColorSpace: 'DeviceRGB', BitsPerComponent: bpc })
    const { out } = await redactPixels(bytes, [BOX])
    const [img] = await pageImages(out)
    expect(img.dict.get(PDFName.of('ColorSpace'))).toBe(PDFName.of('DeviceRGB'))
    expect(num(img.dict, 'BitsPerComponent')).toBe(bpc)
    expectBlanked(img.samples, src, BOX_PX, { nc: 3, bpc })
    const from = (32 * 3 * bpc) / 8
    expect(await pixelLeaks(out, rowBytes(src, stride, 25, from, from + 9 * bpc))).toEqual([])
  })

  it.each([8, 4, 2])(
    '%i-bit Indexed: the palette kept, blanked with its darkest entry',
    async (bpc) => {
      const lookup = Uint8Array.from([250, 10, 10, 10, 250, 10, 5, 5, 5, 10, 10, 250])
      const stride = Math.ceil((W * bpc) / 8)
      const src = noise(stride * H, 7 + bpc)
      // Only indices 0–3 are defined: keep every sample in range.
      for (let i = 0; i < src.length; i++)
        src[i] = bpc === 8 ? src[i] & 3 : bpc === 4 ? src[i] & 0x33 : src[i]
      const doc = await PDFDocument.create()
      const page = doc.addPage([400, 400])
      const lut = doc.context.register(doc.context.stream(lookup))
      const cs = doc.context.obj([PDFName.of('Indexed'), PDFName.of('DeviceRGB'), 3, lut])
      place(page, imageStream(page, src, W, H, { ColorSpace: cs, BitsPerComponent: bpc }), M)
      const bytes = await doc.save()
      const { r, out } = await redactPixels(bytes, [BOX])
      expect(r.pixels.get(0)).toHaveLength(1)
      const [img] = await pageImages(out)
      expect(num(img.dict, 'BitsPerComponent')).toBe(bpc)
      const csOut = img.dict.lookup(PDFName.of('ColorSpace'), PDFArray)
      expect(csOut.get(0)).toBe(PDFName.of('Indexed'))
      const lutOut = csOut.lookup(3) as PDFRawStream
      expect(Array.from(decodePDFRawStream(lutOut).decode())).toEqual(Array.from(lookup))
      expectBlanked(img.samples, src, BOX_PX, { bpc, blank: 2 })
    }
  )

  it('DCT: a flat JPEG is redacted at 8 bits; a photo-like one fails the growth gate and goes whole', async () => {
    const jpegOf = (rgba: Buffer, q = 90): Uint8Array => new Uint8Array(jpeg.encode({ width: W, height: H, data: rgba }, q).data) // prettier-ignore
    const flat = jpegOf(Buffer.alloc(W * H * 4, 180))
    const rgbDict = { ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'DCTDecode' }
    const a = await redactPixels(await onePage(flat, rgbDict, { raw: true }), [BOX])
    expect(a.r.pixels.get(0)).toHaveLength(1)
    const [img] = await pageImages(a.out)
    expect(img.dict.get(PDFName.of('Filter'))).toBe(PDFName.of('FlateDecode'))
    const px = a.r.pixels.get(0)![0]
    expect(px.final.data.length).toBeLessThanOrEqual(MAX_GROWTH * px.sourceLength)
    // Smooth shading at q 50: tiny as JPEG, its decode (with the codec's ringing) is not as Flate.
    const shade = Buffer.alloc(W * H * 4)
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++)
        for (let c = 0; c < 3; c++)
          shade[(y * W + x) * 4 + c] =
            128 + 90 * Math.sin(x / (5 + c) + y / 9) * Math.cos(y / (4 + c))
    const photo = jpegOf(shade, 50)
    const b = await redactPixels(await onePage(photo, rgbDict, { raw: true }), [BOX])
    expect(b.r.pixels.size).toBe(0)
    expect(b.r.removed.get(0)!.map((o) => o.type)).toEqual([3])
    expect(await pageImages(b.out)).toEqual([])
  })
})

describe('fax scans: 1-bit sources are re-encoded as 1-bit Flate', () => {
  /** The fax200 synth scan as a CCITT G4 image (our encoder), filling its page. */
  async function g4Scan(): Promise<{ bytes: Uint8Array; data: Uint8Array; w: number; h: number }> {
    const { width: w, height: h, data } = fax.raster
    const g4 = encodeG4(
      Array.from(data, (v) => (v < 128 ? 1 : 0)),
      w,
      h
    )
    const doc = await PDFDocument.create()
    const { width: pw, height: ph } = fax.gt.page
    const page = doc.addPage([pw, ph])
    const dict = { ColorSpace: 'DeviceGray', BitsPerComponent: 1, Filter: 'CCITTFaxDecode', DecodeParms: { K: -1, Columns: w, Rows: h } } // prettier-ignore
    place(page, imageStream(page, g4, w, h, dict, true), [pw, 0, 0, ph, 0, 0])
    return { bytes: await doc.save(), data, w, h }
  }

  it('our G4 encoder round-trips through PDFium bit for bit', async () => {
    const { bytes, data, w, h } = await g4Scan()
    const r = redactPdfReport(pdfium, bytes, [{ pageIndex: 0, rects: [{ x: 0, y: 0, w: 1, h: 1 }] }], { pixels: await imageCandidates(bytes, [0]) }) // prettier-ignore
    const { interim, rects } = r.pixels.get(0)![0]
    // The interim is PDFium's decode, blanked in the bottom-left corner only.
    const [{ c0, c1, r0, r1 }] = rects
    expect([c0, r1]).toEqual([0, h - 1])
    let diff = 0
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const want = y >= r0 && y <= r1 && x >= c0 && x <= c1 ? 0 : data[y * w + x] < 128 ? 0 : 255 // prettier-ignore
        if (interim.data[y * w + x] !== want) diff++
      }
    expect(diff).toBe(0)
  })

  it('CCITT G4: the copy is 1-bit Flate, within the growth gate, and blanked', async () => {
    const { bytes, data, w, h } = await g4Scan()
    const word = fax.gt.words[Math.floor(fax.gt.words.length / 2)]
    const { r, out } = await redactPixels(bytes, [word.box])
    const px = r.pixels.get(0)
    // [measured, fax200 seed 3: see the ratio below] a text fax page's 1-bit Flate stays within 2×.
    expect(px).toHaveLength(1)
    const [img] = await pageImages(out)
    expect(num(img.dict, 'BitsPerComponent')).toBe(1)
    expect(img.dict.get(PDFName.of('Filter'))).toBe(PDFName.of('FlateDecode'))
    const ratio = img.stored / px![0].sourceLength
    expect(ratio).toBeLessThanOrEqual(MAX_GROWTH)
    const stride = Math.ceil(w / 8)
    const src = new Uint8Array(stride * h)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) if (data[y * w + x] >= 128) src[y * stride + (x >> 3)] |= 0x80 >> (x & 7) // prettier-ignore
    expectBlanked(img.samples, src, px![0].rects[0], { w, h, bpc: 1 })
  })

  it('1-bit Flate (the fax200 synth scan itself) stays 1-bit and within 2×', async () => {
    const word = fax.gt.words[Math.floor(fax.gt.words.length / 2)]
    const { r, out } = await redactPixels(fax.pdfBytes, [word.box])
    expect(r.pixels.get(0)).toHaveLength(1)
    const [img] = await pageImages(out)
    const [before] = await pageImages(fax.pdfBytes)
    expect(num(before.dict, 'BitsPerComponent')).toBe(1)
    expect(num(img.dict, 'BitsPerComponent')).toBe(1)
    expect(img.stored).toBeLessThanOrEqual(MAX_GROWTH * before.stored)
  })
})

// ---------------------------------------------------------------------------------------------
// The shared XObject

describe('an image shared by two pages', () => {
  async function twoPages(inherit: boolean): Promise<{ bytes: Uint8Array; src: Uint8Array }> {
    const src = gray8(9)
    const doc = await PDFDocument.create()
    const p0 = doc.addPage([400, 400])
    const p1 = doc.addPage([400, 400])
    const ref = imageStream(p0, src, W, H, GRAY)
    if (!inherit) {
      place(p0, ref, M)
      place(p1, ref, M)
    } else {
      // One /Resources on the page tree, inherited by both pages.
      for (const p of [p0, p1])
        p.pushOperators(pushGraphicsState(), concatTransformationMatrix(...M), drawObject('Im'), popGraphicsState()) // prettier-ignore
      for (const p of [p0, p1]) p.node.delete(PDFName.of('Resources'))
      const res = doc.context.obj({ XObject: { Im: ref } })
      doc.catalog.Pages().set(PDFName.of('Resources'), res)
    }
    return { bytes: await doc.save(), src }
  }

  it.each([false, true])(
    'inherited resources: %s — the other page keeps the shared XObject and its pixels',
    async (inherit) => {
      const { bytes, src } = await twoPages(inherit)
      const { r, out } = await redactPixels(bytes, [BOX], 0)
      expect(r.pixels.get(0)).toHaveLength(1)
      const on0 = await pageImages(out, 0)
      expect(on0).toHaveLength(1)
      expectBlanked(on0[0].samples, src, BOX_PX)
      // Page 1 still lists the shared object, with the very same pixels. (With inherited resources
      // PDFium also adds page 0's copy to the shared dictionary, and gives page 0 its own: page 1
      // then lists the copy too, unused [measured, PDFium in @embedpdf/pdfium 2.14.4].)
      const on1 = await pageImages(out, 1)
      const shared = on1.filter((i) => Buffer.compare(Buffer.from(i.samples), Buffer.from(src)) === 0) // prettier-ignore
      expect(shared).toHaveLength(1)
      expect(shared[0].ref).not.toEqual(on0[0].ref)
      expect(on1.map((i) => i.ref.toString()).sort()).toEqual(inherit ? [on0[0].ref, shared[0].ref].map(String).sort() : [shared[0].ref.toString()]) // prettier-ignore
      // It is still the ONE shared object: redacting page 1 too gives it its own copy as well.
      const before = await PDFDocument.load(bytes)
      const imagesIn = (d: PDFDocument): number =>
        d.context.enumerateIndirectObjects().filter(([, o]) => o instanceof PDFRawStream && o.dict.get(PDFName.of('Subtype')) === PDFName.of('Image')).length // prettier-ignore
      expect(imagesIn(before)).toBe(1)
      expect(imagesIn(await PDFDocument.load(out))).toBe(2)
      // Page 1 renders exactly as before.
      expect(Buffer.compare(Buffer.from(raster(out, 72, 1).data), Buffer.from(raster(bytes, 72, 1).data))).toBe(0) // prettier-ignore
    }
  )

  it('the same image drawn twice on one page: only the covered placement changes', async () => {
    const src = gray8(10)
    const doc = await PDFDocument.create()
    const page = doc.addPage([400, 400])
    const ref = imageStream(page, src, W, H, GRAY)
    const name = place(page, ref, M)
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(240, 0, 0, 160, 40, 230), drawObject(name), popGraphicsState()) // prettier-ignore
    const bytes = await doc.save()
    const { r, out } = await redactPixels(bytes, [BOX])
    expect(r.pixels.get(0)).toHaveLength(1)
    const imgs = await pageImages(out)
    expect(imgs).toHaveLength(2)
    const untouched = imgs.filter((i) => Buffer.compare(Buffer.from(i.samples), Buffer.from(src)) === 0) // prettier-ignore
    expect(untouched).toHaveLength(1)
    // The upper placement (y 230–390) renders as before.
    const a = raster(bytes, 72).data
    const b = raster(out, 72).data
    expect(Buffer.compare(Buffer.from(a.subarray(0, 168 * 400)), Buffer.from(b.subarray(0, 168 * 400)))).toBe(0) // prettier-ignore
  })
})

// ---------------------------------------------------------------------------------------------
// Fallbacks: whole-image removal

describe('out of scope: the whole image is removed, as before', () => {
  /** The pass falls back: no copy, the image reported removed, its pixels nowhere. */
  async function expectWhole(
    bytes: Uint8Array,
    needle: Uint8Array | null,
    rects = [BOX]
  ): Promise<void> {
    const { r, out } = await redactPixels(bytes, rects)
    expect(r.pixels.size).toBe(0)
    expect(r.removed.get(0)!.map((o) => o.type)).toEqual([3])
    expect(await pageImages(out)).toEqual([])
    if (needle) expect(await pixelLeaks(out, needle)).toEqual([])
  }
  const src = gray8(12)
  const needle = needleOf(src)

  it.each<[string, Dict]>([
    ['/Decode', { Decode: [1, 0] }],
    ['/Mask (colour key)', { Mask: [0, 3] }],
    ['16 bits', { BitsPerComponent: 16 }]
  ])('%s', async (_, extra) => {
    const data = extra.BitsPerComponent === 16 ? noise(W * H * 2, 3) : src
    await expectWhole(await onePage(data, { ...GRAY, ...extra }), extra.BitsPerComponent ? null : needle) // prettier-ignore
  })

  it('/ImageMask', async () => {
    await expectWhole(await onePage(noise(15 * H, 4), { ImageMask: true }), null)
  })

  it('/SMask', async () => {
    const doc = await PDFDocument.create()
    const page = doc.addPage([400, 400])
    const smask = imageStream(page, new Uint8Array(W * H).fill(255), W, H, GRAY)
    place(page, imageStream(page, src, W, H, { ...GRAY, SMask: smask }), M)
    await expectWhole(await doc.save(), needle)
  })

  it('ICCBased and DeviceCMYK colour spaces', async () => {
    const doc = await PDFDocument.create()
    const page = doc.addPage([400, 400])
    const icc = doc.context.register(doc.context.flateStream(new Uint8Array(128), { N: 1 }))
    place(page, imageStream(page, src, W, H, { ColorSpace: doc.context.obj([PDFName.of('ICCBased'), icc]), BitsPerComponent: 8 }), M) // prettier-ignore
    await expectWhole(await doc.save(), needle)
    await expectWhole(await onePage(noise(W * H * 4, 13), { ColorSpace: 'DeviceCMYK', BitsPerComponent: 8 }), null) // prettier-ignore
  })

  it('JPX', async () => {
    // Not a decodable codestream: PDFium still places it, and the plan alone rules it out.
    await expectWhole(await onePage(noise(400, 14), { ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'JPXDecode' }, { raw: true }), null) // prettier-ignore
  })

  it('a quarter-turned, a skewed and a slightly rotated placement', async () => {
    await expectWhole(await onePage(src, GRAY, { m: [0, 160, -240, 0, 300, 60] }), needle, [{ x: 150, y: 100, w: 30, h: 30 }]) // prettier-ignore
    await expectWhole(await onePage(src, GRAY, { m: [240, 0, 40, 160, 20, 60] }), needle)
    const t = (0.5 * Math.PI) / 180
    await expectWhole(await onePage(src, GRAY, { m: [240 * Math.cos(t), 240 * Math.sin(t), -160 * Math.sin(t), 160 * Math.cos(t), 40, 60] }), needle) // prettier-ignore
  })

  it('an inline image', async () => {
    const doc = await PDFDocument.create()
    const page = doc.addPage([400, 400])
    const head = `q 240 0 0 160 40 60 cm BI /W ${W} /H ${H} /CS /G /BPC 8 ID `
    const content = new Uint8Array([...Buffer.from(head, 'latin1'), ...src, ...Buffer.from(' EI Q', 'latin1')]) // prettier-ignore
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(content)))
    await expectWhole(await doc.save({ useObjectStreams: false }), needle)
  })

  it('a clip path, a transparent graphics state, marked content', async () => {
    const make = async (ops: (page: PDFPage, ref: PDFRef) => void): Promise<Uint8Array> => {
      const doc = await PDFDocument.create()
      const page = doc.addPage([400, 400])
      ops(page, imageStream(page, src, W, H, GRAY))
      return doc.save()
    }
    const draw = (page: PDFPage, ref: PDFRef, before: PDFOperator[]): void => {
      const n = page.node.newXObject('Im', ref)
      page.pushOperators(pushGraphicsState(), ...before, concatTransformationMatrix(...M), drawObject(n), popGraphicsState()) // prettier-ignore
    }
    const op = (name: string, ...args: unknown[]): PDFOperator => PDFOperator.of(name as never, args as never) // prettier-ignore
    const n = (v: number): PDFNumber => PDFNumber.of(v)
    await expectWhole(await make((p, ref) => draw(p, ref, [op('re', n(40), n(60), n(200), n(150)), op('W'), op('n')])), needle) // prettier-ignore
    await expectWhole(
      await make((p, ref) => {
        const gs = p.node.newExtGState('GS', p.doc.context.obj({ ca: 0.5, CA: 0.5 }))
        draw(p, ref, [op('gs', gs)])
      }),
      needle
    )
    await expectWhole(
      await make((p, ref) => {
        p.pushOperators(op('BDC', PDFName.of('Figure'), p.doc.context.obj({ MCID: 0 })))
        draw(p, ref, [])
        p.pushOperators(op('EMC'))
      }),
      needle
    )
  })

  it('data PDFium cannot decode in full (a truncated Flate stream)', async () => {
    const cut = zlibSync(src).slice(0, 2000)
    await expectWhole(await onePage(cut, { ...GRAY, Filter: 'FlateDecode' }, { raw: true }), null)
  })

  it('the growth gate: a predictor-coded source whose plain Flate copy would be > 2×', async () => {
    // A random walk along each row: PNG Sub-filtered it is nearly all 0s and 1s, plain it is not.
    const walk = new Uint8Array(W * H)
    const steps = noise(W * H, 15)
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++)
        walk[y * W + x] = x ? (walk[y * W + x - 1] + (steps[y * W + x] & 1)) & 255 : steps[y * W] // prettier-ignore
    const png = new Uint8Array((W + 1) * H)
    for (let y = 0; y < H; y++) {
      png[y * (W + 1)] = 1 // Sub
      for (let x = 0; x < W; x++)
        png[y * (W + 1) + 1 + x] = (walk[y * W + x] - (x ? walk[y * W + x - 1] : 0)) & 255
    }
    const doc = await PDFDocument.create()
    const page = doc.addPage([400, 400])
    const ref = imageStream(page, zlibSync(png, { level: 9 }), W, H, { ...GRAY, Filter: 'FlateDecode', DecodeParms: { Predictor: 15, Colors: 1, BitsPerComponent: 8, Columns: W } }, true) // prettier-ignore
    place(page, ref, M)
    const bytes = await doc.save()
    expect(zlibSync(walk, { level: 9 }).length).toBeGreaterThan(MAX_GROWTH * (await pageImages(bytes))[0].stored) // prettier-ignore
    await expectWhole(bytes, needleOf(walk))
    // Control: the same image without a predictor is in scope (PDFium undid the predictor above).
    const plain = await redactPixels(await onePage(walk, GRAY), [BOX])
    expect(plain.r.pixels.get(0)).toHaveLength(1)
  })

  it("a plan that disagrees with PDFium's reading of the object (layout) is not used", async () => {
    const rgb = noise(W * H * 3, 16)
    const bytes = await onePage(rgb, { ColorSpace: 'DeviceRGB', BitsPerComponent: 8 })
    const [cand] = (await imageCandidates(bytes, [0])).get(0)!
    const asGray: ImageCandidate = { ...cand, plan: { decode: 'samples', colorSpace: { kind: 'DeviceGray' }, bpc: 8 } } // prettier-ignore
    const as1bit: ImageCandidate = { ...cand, plan: { decode: 'samples', colorSpace: { kind: 'DeviceRGB' }, bpc: 1 } } // prettier-ignore
    for (const c of [asGray, as1bit]) {
      const r = redactPdfReport(pdfium, bytes, [{ pageIndex: 0, rects: [BOX] }], { pixels: new Map([[0, [c]]]) }) // prettier-ignore
      expect(r.pixels.size).toBe(0)
      expect(r.removed.get(0)!.map((o) => o.type)).toEqual([3])
    }
    // Control: its own plan is used.
    const ok = redactPdfReport(pdfium, bytes, [{ pageIndex: 0, rects: [BOX] }], { pixels: new Map([[0, [cand]]]) }) // prettier-ignore
    expect(ok.pixels.get(0)).toHaveLength(1)
  })

  it('no candidates (the pre-pass not run): whole removal, as before PR12', async () => {
    const bytes = await onePage(src, GRAY)
    const r = redactPdfReport(pdfium, bytes, [{ pageIndex: 0, rects: [BOX] }])
    expect(r.pixels.size).toBe(0)
    expect(r.removed.get(0)!.map((o) => o.type)).toEqual([3])
  })

  it('a copy the pdf-lib pass cannot find throws PixelSwapError', async () => {
    const bytes = await onePage(src, GRAY)
    const pixels = await imageCandidates(bytes, [0])
    const r = redactPdfReport(pdfium, bytes, [{ pageIndex: 0, rects: [BOX] }], { pixels })
    const rep = r.pixels.get(0)![0]
    const wrong = new Map([[0, [{ ...rep, interim: { ...rep.interim, data: rep.interim.data.map((v) => v ^ 1) } }]]]) // prettier-ignore
    const doc = await PDFDocument.load(r.bytes)
    expect(() => swapPixelImages(doc, wrong)).toThrow(PixelSwapError)
    await expect(sanitizeRedacted(r.bytes, [0], wrong)).rejects.toThrow(PixelSwapError)
  })
})

// ---------------------------------------------------------------------------------------------
// Through the export: frames, rendering, OCR

const opened: { destroy(): Promise<void> }[] = []
afterAll(async () => {
  for (const pdf of opened) await pdf.destroy()
})

async function openDoc(
  id: string,
  bytes: Uint8Array
): Promise<{ doc: DocEntry; pdf: PDFDocumentProxy }> {
  const pdf = (await getDocument({ data: bytes.slice(), verbosity: 0 }).promise) as unknown as PDFDocumentProxy // prettier-ignore
  opened.push(pdf)
  const pages: PageEntry[] = []
  for (let i = 0; i < pdf.numPages; i++) {
    const vp = (await pdf.getPage(i + 1)).getViewport({ scale: 1 })
    pages.push({ id: `${id}-${i}`, source: { id, bytes, pdf }, pageIndex: i, width: vp.width, height: vp.height }) // prettier-ignore
  }
  return { doc: { id: `doc-${id}`, name: id, pages }, pdf }
}

const redaction = (pageKey: string, g: FrameBox): Overlay => ({
  id: `red-${pageKey}-${g.x}`,
  pageKey,
  z: 0,
  createdAt: 0,
  geom: { ...g, rotation: 0, opacity: 1 },
  type: 'redaction',
  fill: { r: 0, g: 0, b: 0 }
})

const edits = (overlays: Map<string, Overlay[]>): EditLayer => ({
  overlays,
  attachments: new Map()
})

describe.each([0, 90, 180, 270])('/Rotate %i, offset MediaBox and CropBox', (rotate) => {
  const MEDIA = { x: 10, y: 20, w: 420, h: 620 }
  const CROP = { x: 30, y: 40, w: 400, h: 600 }
  /** An image over the CropBox, 1 sample = 4 pt (100 × 150 samples). */
  const IW = 100
  const IH = 150

  it('the blanked samples are exactly those under the box as pdf.js places it', async () => {
    const src = noise(IW * IH, 20 + rotate)
    const doc = await PDFDocument.create()
    const page = doc.addPage([MEDIA.w, MEDIA.h])
    page.setMediaBox(MEDIA.x, MEDIA.y, MEDIA.w, MEDIA.h)
    page.setCropBox(CROP.x, CROP.y, CROP.w, CROP.h)
    if (rotate) page.setRotation(degrees(rotate))
    place(page, imageStream(page, src, IW, IH, GRAY), [CROP.w, 0, 0, CROP.h, CROP.x, CROP.y])
    const bytes = await doc.save()
    const { doc: entry, pdf } = await openDoc(`rot${rotate}`, bytes)
    const key = makePageKey(`rot${rotate}`, 0)
    const vw = entry.pages[0].width
    const vh = entry.pages[0].height
    // A box in the visual frame (bottom-left origin), off-centre so a wrong turn would miss it.
    const box = { x: vw * 0.2 + 1.3, y: vh * 0.55 + 0.7, w: 37.1, h: 22.9 }
    const red = await buildRedactedSources(edits(new Map([[key, [redaction(key, box)]]])), [entry], { pdfium, report: true }) // prettier-ignore
    expect(red.removed!.get(key)).toEqual([])
    expect(red.modified!.get(key)).toHaveLength(1)
    const [img] = await pageImages(red.get(`rot${rotate}`)!)
    // Independently, with pdf.js's viewport: a sample is covered when its visual rect meets the
    // box; one sample further out may go (outward rounding), nothing beyond may change.
    const vp = (await pdf.getPage(1)).getViewport({ scale: 1 })
    const b = { x0: box.x, y0: vh - box.y - box.h, x1: box.x + box.w, y1: vh - box.y } // top-left
    const s = CROP.w / IW
    let covered = 0
    for (let r = 0; r < IH; r++)
      for (let c = 0; c < IW; c++) {
        const ux = CROP.x + c * s
        const uy = CROP.y + CROP.h - (r + 1) * s
        const [x0, y0, x1, y1] = vp.convertToViewportRectangle([ux, uy, ux + s, uy + s])
        const q = { x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) } // prettier-ignore
        const meets = (m: number): boolean => q.x0 < b.x1 + m && b.x0 - m < q.x1 && q.y0 < b.y1 + m && b.y0 - m < q.y1 // prettier-ignore
        const v = img.samples[r * IW + c]
        if (meets(0)) {
          covered++
          expect(v, `sample ${c},${r}`).toBe(0)
        } else if (!meets(s)) expect(v, `sample ${c},${r}`).toBe(src[r * IW + c])
      }
    expect(covered).toBeGreaterThan(40)
  })
})

describe('buildRedactedSources', () => {
  it('a copy the pdf-lib pass cannot find: the source is redacted again, the image removed whole', async () => {
    const src = gray8(17)
    const { doc } = await openDoc('swapfail', await onePage(src, GRAY))
    const key = makePageKey('swapfail', 0)
    // The overlay frame is the page (no rotation, origin 0): BOX as is.
    const layer = edits(new Map([[key, [redaction(key, BOX)]]]))
    // PDFium is handed an interim that differs from the one recorded, so it is not found again.
    const spy = Object.create(pdfium) as ProbePdfium
    spy.FPDFImageObj_SetBitmap = (pages, count, obj, bmp) => {
      const p = pdfium.FPDFBitmap_GetBuffer(bmp)
      pdfium.pdfium.HEAPU8[p] ^= 0xff
      return pdfium.FPDFImageObj_SetBitmap(pages, count, obj, bmp)
    }
    const red = await buildRedactedSources(layer, [doc], { pdfium: spy, report: true })
    expect(red.modified!.get(key)).toBeUndefined()
    expect(red.removed!.get(key)).toHaveLength(1)
    expect(await pageImages(red.get('swapfail')!)).toEqual([])
    expect(await pixelLeaks(red.get('swapfail')!, needleOf(src))).toEqual([])
    // Without the fault the same export redacts pixel by pixel; pixelRedaction: false never does.
    const ok = await buildRedactedSources(layer, [doc], { pdfium, report: true })
    expect(ok.modified!.get(key)).toHaveLength(1)
    const off = await buildRedactedSources(layer, [doc], { pdfium, report: true, pixelRedaction: false }) // prettier-ignore
    expect(off.modified!.get(key)).toBeUndefined()
    expect(off.removed!.get(key)).toHaveLength(1)
  })
})

describe('an OCR-layered scan, exported', () => {
  const kinds = ['pdf', 'pdfx'] as const

  it.each(kinds)(
    '%s: the scan stays, only the words under the box go, nothing leaks',
    async (kind) => {
      const target = scan.gt.words.findIndex((w, i) => i > 30 && /^\p{L}{6,}$/u.test(w.t) && scan.gt.words.filter((o) => o.t === w.t).length === 1) // prettier-ignore
      const word = scan.gt.words[target]
      const id = `ocr-${kind}`
      const { doc } = await openDoc(id, scan.pdfBytes)
      const key = makePageKey(id, 0)
      const ocr = ocrPageFromGt(scan.gt)
      const layer = edits(new Map([[key, [redaction(key, word.box)]]]))
      const red = await buildRedactedSources(layer, [doc], { pdfium, report: true })
      expect(red.removed!.get(key)).toEqual([])
      expect(red.modified!.get(key)).toHaveLength(1)
      const withOcr = withOcrLayer(layer, new Map([[key, pack(ocr)]]), { include: true, removed: red.removed }) // prettier-ignore
      const pages = applyRedactedBytes([{ bytes: scan.pdfBytes, sourceKey: id, pageIndex: 0 }], red)
      const file = kind === 'pdf' ? await buildPdf(pages, withOcr) : await buildPdfx([{ name: id, pages }], 'Pixel', withOcr) // prettier-ignore
      // Rule 1 alone: every word whose footprint meets the box goes, all the others stay.
      const meets = (a: FrameBox, b: FrameBox): boolean =>
        a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
      const kept: string[] = []
      for (const line of ocr.lines)
        for (const w of line.words) {
          const f = wordFootprint(w, line)
          if (!meets({ x: f.x0, y: f.y0, w: f.x1 - f.x0, h: f.y1 - f.y0 }, word.box)) kept.push(w.t)
        }
      expect(kept.length).toBeGreaterThanOrEqual(scan.gt.words.length - 4)
      const words = pdfjsCopyText((await pdfjsText(file, 0)).items)
        .split(/\s+/)
        .filter(Boolean)
      expect(words).toEqual(kept)
      expect(await rawLeaks(file, { words: [word.t], uniqueCps: [] })).toEqual([])
      expect(await extractorLeaks(pdfium, file, { words: [word.t], uniqueCps: [] })).toEqual([])
      // The scan is still there, and its covered pixels are not, anywhere in the file.
      const s = scan.raster
      const { c0, c1, r0, r1 } = (await redactPixels(scan.pdfBytes, [word.box])).r.pixels.get(0)![0].rects[0] // prettier-ignore
      expect(c1 - c0).toBeGreaterThan(30)
      const ry = Math.floor((r0 + r1) / 2)
      const needle = s.data.slice(ry * s.width + c0 + 2, ry * s.width + c1 - 1)
      expect(new Set(needle).size).toBeGreaterThan(2) // ink and paper: a real needle
      expect(await pixelLeaks(scan.pdfBytes, needle)).toHaveLength(1) // control
      expect(await pixelLeaks(file, needle)).toEqual([])
    }
  )

  it('renders black under the box and as the source everywhere else', async () => {
    const word = scan.gt.words[40]
    const { out, r } = await redactPixels(scan.pdfBytes, [word.box])
    const dpi = scan.gt.dpi
    const a = raster(scan.pdfBytes, dpi)
    const b = raster(out, dpi)
    expect([b.width, b.height]).toEqual([a.width, a.height])
    const k = dpi / 72
    const ph = scan.gt.page.height
    const bx0 = word.box.x * k
    const bx1 = (word.box.x + word.box.w) * k
    const by0 = (ph - word.box.y - word.box.h) * k
    const by1 = (ph - word.box.y) * k
    let under = 0
    let darkUnder = 0
    let outside = 0
    let changed = 0
    for (let y = 0; y < a.height; y++)
      for (let x = 0; x < a.width; x++) {
        const i = y * a.width + x
        if (
          x >= Math.ceil(bx0) &&
          x < Math.floor(bx1) &&
          y >= Math.ceil(by0) &&
          y < Math.floor(by1)
        ) {
          under++
          if (b.data[i] === 0) darkUnder++
        } else if (x < bx0 - 3 || x >= bx1 + 3 || y < by0 - 3 || y >= by1 + 3) {
          outside++
          if (a.data[i] !== b.data[i]) changed++
        }
      }
    expect(under).toBeGreaterThan(100)
    expect(darkUnder).toBe(under)
    expect(changed).toBe(0)
    expect(outside).toBeGreaterThan(a.width * a.height * 0.9)
    // And the decoded crop of the copy: blanked under the box, byte-identical elsewhere.
    const [img] = await pageImages(out)
    expectBlanked(img.samples, scan.raster.data, r.pixels.get(0)![0].rects[0], { w: a.width, h: a.height }) // prettier-ignore
  })
})
