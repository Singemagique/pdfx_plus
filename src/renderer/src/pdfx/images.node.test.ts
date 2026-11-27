import { PDFDocument } from 'pdf-lib'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  imageStampSize,
  imageToPdf,
  jpegNeedsReorient,
  jpegSize,
  prepareImageStamp
} from './images'
import { exifApp1, jpegWith } from './test-utils/jpeg'

// Minimal JPEG: SOI, optional segments, then an SOF0 frame header carrying [precision, H(2), W(2)].
function jpegWithSof(width: number, height: number, lead: number[] = []): Uint8Array {
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01] // prettier-ignore
  return new Uint8Array([0xff, 0xd8, ...lead, ...sof])
}

describe('jpegSize (P2-6 pre-decode bomb guard)', () => {
  it('reads dimensions from a direct SOF0 header', () => {
    expect(jpegSize(jpegWithSof(200, 100))).toEqual({ width: 200, height: 100 })
  })

  it('skips a preceding APP0 (JFIF) segment to find the SOF', () => {
    // APP0: FF E0, length 0x0010 (16), then 14 payload bytes.
    const app0 = [0xff, 0xe0, 0x00, 0x10, ...new Array(14).fill(0x00)]
    expect(jpegSize(jpegWithSof(640, 480, app0))).toEqual({ width: 640, height: 480 })
  })

  it('surfaces bomb-scale dimensions (caller rejects before decode)', () => {
    const dim = jpegSize(jpegWithSof(30000, 30000))
    expect(dim).toEqual({ width: 30000, height: 30000 })
    expect(dim!.width * dim!.height).toBeGreaterThan(100 * 1024 * 1024) // over the 100 MP cap
  })

  it('returns null for non-JPEG bytes', () => {
    expect(jpegSize(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull() // PNG signature
  })
})

// PNG signature + an IHDR chunk carrying only the dimensions. imageToPdf's PNG branch reads IHDR
// (offsets 16/20) and throws BEFORE embedPng or any DOM API, so the bomb path is testable in node.
function pngWithIHDR(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) // \x89PNG\r\n\x1a\n
  bytes.set([0x49, 0x48, 0x44, 0x52], 12) // 'IHDR'
  const dv = new DataView(bytes.buffer)
  dv.setUint32(8, 13) // IHDR chunk length
  dv.setUint32(16, width)
  dv.setUint32(20, height)
  return bytes
}

// A real (opaque, single-pixel) PNG — the smallest input the embed path will actually accept.
const ONE_PIXEL_PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  ),
  (c) => c.charCodeAt(0)
)

describe('imageToPdf PNG branch (the older half of the pixel cap)', () => {
  it('rejects a decompression-bomb PNG on its IHDR dimensions alone', async () => {
    // 30000² = 900 MP, nine times the 100 MP cap — and ~3.6 GB if it were ever decoded.
    await expect(imageToPdf(pngWithIHDR(30000, 30000))).rejects.toThrow(/too large/)
  })

  it('accepts a PNG exactly AT the cap without decoding it', async () => {
    // 10240 × 10240 = 100 × 1024 × 1024 px, MAX_IMAGE_PIXELS exactly — the `>` cap must allow it
    // (a `>=` regression would reject it). embedPng then rejects the truncated bytes, so reaching
    // ANY other error proves the size guard let this one through.
    await expect(imageToPdf(pngWithIHDR(10240, 10240))).rejects.not.toThrow(/too large/)
  })

  it('turns a small PNG into a one-page PDF', async () => {
    const pdf = await imageToPdf(ONE_PIXEL_PNG)
    const doc = await PDFDocument.load(pdf)
    expect(doc.getPageCount()).toBe(1)
    const { width, height } = doc.getPage(0).getSize()
    expect([width, height]).toEqual([1, 1]) // page defaults to the image's own dimensions
  })

  it('honours an explicit page size, fitting the image inside it', async () => {
    const pdf = await imageToPdf(ONE_PIXEL_PNG, { width: 612, height: 792 })
    const doc = await PDFDocument.load(pdf)
    expect(doc.getPageCount()).toBe(1)
    expect(doc.getPage(0).getSize()).toMatchObject({ width: 612, height: 792 })
  })
})

// A phone photo as stored: a 200×100 landscape sensor frame whose EXIF says how to turn it upright.
const exifJpeg = (orientation: number, little = true): Uint8Array =>
  jpegWith([exifApp1(orientation, { little })], { width: 200, height: 100 })

describe('jpegNeedsReorient (EXIF orientation decided from the header bytes)', () => {
  it('is false for an upright JPEG, a JPEG with no EXIF, and a PNG', () => {
    expect(jpegNeedsReorient(exifJpeg(1))).toBe(false)
    expect(jpegNeedsReorient(jpegWith([]))).toBe(false)
    expect(jpegNeedsReorient(ONE_PIXEL_PNG)).toBe(false)
  })

  it('is true for 90° turns in either byte order', () => {
    expect(jpegNeedsReorient(exifJpeg(6, true))).toBe(true)
    expect(jpegNeedsReorient(exifJpeg(8, false))).toBe(true)
  })

  it('catches what a bitmap width comparison cannot: a 180° turn and a square image', () => {
    expect(jpegNeedsReorient(exifJpeg(3))).toBe(true) // same width either way up
    const square = jpegWith([exifApp1(6, { little: true })], { width: 300, height: 300 })
    expect(jpegNeedsReorient(square)).toBe(true)
  })
})

// Node has no createImageBitmap or canvas: stand in for Chromium, where the default decode applies
// EXIF (so a 200×100 orientation-6 frame decodes to an upright 100×200 bitmap) and — the bug —
// { imageOrientation: 'none' } is ignored, returning the same upright bitmap.
function stubBrowserImaging(upright: { width: number; height: number }): {
  createImageBitmap: ReturnType<typeof vi.fn>
  canvas: { width: number; height: number; drawn: unknown[] }
  closed: () => number
} {
  let closes = 0
  const createImageBitmap = vi.fn(async () => ({ ...upright, close: () => void closes++ }))
  const canvas = {
    width: 0,
    height: 0,
    drawn: [] as unknown[],
    getContext: () => ({ drawImage: (bmp: unknown) => canvas.drawn.push(bmp) }),
    toBlob: (cb: (b: Blob | null) => void) => cb(new Blob([ONE_PIXEL_PNG], { type: 'image/png' }))
  }
  vi.stubGlobal('createImageBitmap', createImageBitmap)
  vi.stubGlobal('document', { createElement: () => canvas })
  return { createImageBitmap, canvas, closed: () => closes }
}

describe('imageToPdf JPEG branch (EXIF orientation)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('embeds an upright JPEG as-is, without decoding it', async () => {
    const { createImageBitmap } = stubBrowserImaging({ width: 200, height: 100 })
    const doc = await PDFDocument.load(await imageToPdf(exifJpeg(1)))
    expect(createImageBitmap).not.toHaveBeenCalled()
    expect(doc.getPage(0).getSize()).toEqual({ width: 200, height: 100 })
  })

  it('re-encodes an EXIF-rotated JPEG from the oriented bitmap instead of embedding it sideways', async () => {
    const { createImageBitmap, canvas, closed } = stubBrowserImaging({ width: 100, height: 200 })
    const doc = await PDFDocument.load(await imageToPdf(exifJpeg(6)))
    // One default (EXIF-applying) decode, rasterised at its upright size...
    expect(createImageBitmap).toHaveBeenCalledTimes(1)
    expect(createImageBitmap.mock.calls[0]).toHaveLength(1)
    expect([canvas.width, canvas.height]).toEqual([100, 200])
    expect(canvas.drawn).toHaveLength(1)
    expect(closed()).toBe(1)
    // ...and the page is built from that PNG (1×1 stand-in), not the raw 200×100 sideways JPEG.
    expect(doc.getPage(0).getSize()).toEqual({ width: 1, height: 1 })
  })
})

describe('prepareImageStamp (image stamp attachment matches its overlay)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('stores an EXIF-rotated JPEG as upright PNG bytes, sized by the oriented bitmap', async () => {
    const { canvas } = stubBrowserImaging({ width: 100, height: 200 })
    const stamp = await prepareImageStamp(exifJpeg(6), 'image/jpeg')
    expect(stamp.mime).toBe('image/png')
    expect(Array.from(stamp.bytes)).toEqual(Array.from(ONE_PIXEL_PNG))
    expect({ width: stamp.width, height: stamp.height }).toEqual({ width: 100, height: 200 })
    expect([canvas.width, canvas.height]).toEqual([100, 200])
  })

  it('passes an upright JPEG and a PNG through untouched', async () => {
    const { canvas } = stubBrowserImaging({ width: 200, height: 100 })
    const jpeg = exifJpeg(1)
    const j = await prepareImageStamp(jpeg, 'image/jpeg')
    expect(j).toEqual({ bytes: jpeg, mime: 'image/jpeg', width: 200, height: 100 })
    const p = await prepareImageStamp(ONE_PIXEL_PNG, 'image/png')
    expect(p.bytes).toBe(ONE_PIXEL_PNG)
    expect(p.mime).toBe('image/png')
    expect(canvas.drawn).toHaveLength(0) // nothing was re-encoded
  })
})

describe('imageStampSize (initial image-stamp size at an assumed 150 DPI)', () => {
  it('sizes pixels at 150 DPI rather than as points (72 DPI)', () => {
    // 300 px at 150 DPI = 2 in = 144 pt (was 300 pt).
    expect(imageStampSize({ width: 300, height: 150 }, 612)).toEqual({ width: 144, height: 72 })
  })

  it('caps the width at the page fraction, keeping the aspect ratio', () => {
    const { width, height } = imageStampSize({ width: 4000, height: 3000 }, 612)
    expect(width).toBeCloseTo(244.8)
    expect(height).toBeCloseTo(183.6)
    expect(imageStampSize({ width: 4000, height: 2000 }, 600, 0.25)).toEqual({
      width: 150,
      height: 75
    })
  })

  it('treats degenerate dimensions as 1 px instead of dividing by zero', () => {
    const { width, height } = imageStampSize({ width: 0, height: 0 }, 612)
    expect(Number.isFinite(width) && Number.isFinite(height)).toBe(true)
    expect(width).toBeCloseTo(0.48)
  })
})
