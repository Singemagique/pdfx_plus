import { PDFDocument } from 'pdf-lib'
import { describe, expect, it } from 'vitest'

import { imageToPdf, jpegSize } from './images'

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

  it('accepts a PNG just under the cap without decoding it', async () => {
    // 10000 × 10000 = 100 MP exactly, which the `>` cap allows; embedPng then rejects the truncated
    // bytes, so reaching ANY other error proves the size guard let this one through.
    await expect(imageToPdf(pngWithIHDR(10000, 10000))).rejects.not.toThrow(/too large/)
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
