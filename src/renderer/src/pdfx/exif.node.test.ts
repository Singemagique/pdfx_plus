import { describe, expect, it } from 'vitest'

import { jpegOrientation } from './exif'
import { exifApp1, jpegWith } from './test-utils/jpeg'

describe('jpegOrientation', () => {
  for (const little of [true, false]) {
    const order = little ? 'II (little-endian)' : 'MM (big-endian)'
    for (const orientation of [1, 3, 6, 8]) {
      it(`reads orientation ${orientation} from a ${order} EXIF block`, () => {
        expect(jpegOrientation(jpegWith([exifApp1(orientation, { little })]))).toBe(orientation)
      })
    }
  }

  it('finds the orientation tag when it is not the first IFD0 entry', () => {
    const app1 = exifApp1(6, { little: true, leadingEntries: 3 })
    expect(jpegOrientation(jpegWith([app1]))).toBe(6)
  })

  it('skips a preceding APP0 (JFIF) and a non-EXIF APP1 (XMP) to reach the EXIF block', () => {
    const app0 = [0xff, 0xe0, 0x00, 0x10, ...new Array(14).fill(0x00)]
    const xmpId = [...'http://ns.adobe.com/xap/1.0/\0'].map((c) => c.charCodeAt(0))
    const xmp = [0xff, 0xe1, 0x00, xmpId.length + 2, ...xmpId]
    expect(jpegOrientation(jpegWith([app0, xmp, exifApp1(8, { little: false })]))).toBe(8)
  })

  it('returns 1 when the JPEG has no EXIF block', () => {
    expect(jpegOrientation(jpegWith([]))).toBe(1)
  })

  it('stops at SOS: an EXIF-looking block inside scan data is not metadata', () => {
    const sos = [0xff, 0xda, 0x00, 0x02]
    expect(jpegOrientation(jpegWith([sos, exifApp1(6, { little: true })]))).toBe(1)
  })

  it('returns 1 for an out-of-range orientation value', () => {
    expect(jpegOrientation(jpegWith([exifApp1(9, { little: true })]))).toBe(1)
    expect(jpegOrientation(jpegWith([exifApp1(0, { little: false })]))).toBe(1)
  })

  it('returns 1 (never throws) for garbage, empty and non-JPEG input', () => {
    expect(jpegOrientation(new Uint8Array())).toBe(1)
    expect(jpegOrientation(new Uint8Array([0xff]))).toBe(1)
    expect(jpegOrientation(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))).toBe(1) // PNG
    let seed = 12345
    for (let n = 0; n < 200; n++) {
      const junk = new Uint8Array(64).map(() => (seed = (seed * 1103515245 + 12345) >>> 0) & 0xff)
      junk[0] = 0xff
      junk[1] = 0xd8 // JPEG signature followed by noise
      expect(() => jpegOrientation(junk)).not.toThrow()
      expect(jpegOrientation(junk)).toBeGreaterThanOrEqual(1)
      expect(jpegOrientation(junk)).toBeLessThanOrEqual(8)
    }
  })

  it('returns 1 for every truncation of a valid EXIF JPEG without throwing', () => {
    const full = jpegWith([exifApp1(6, { little: false })])
    for (let len = 0; len < full.length; len++) {
      const cut = full.subarray(0, len)
      expect(() => jpegOrientation(cut)).not.toThrow()
    }
    expect(jpegOrientation(full)).toBe(6)
  })

  it('rejects a TIFF header with the wrong magic number or byte-order mark', () => {
    const badMagic = exifApp1(6, { little: true })
    badMagic[12] = 0x2b // 43 instead of 42 (APP1 header 4 + 'Exif\0\0' 6 + 'II' 2)
    expect(jpegOrientation(jpegWith([badMagic]))).toBe(1)
    const badOrder = exifApp1(6, { little: true })
    badOrder[10] = 0x58 // 'XI'
    expect(jpegOrientation(jpegWith([badOrder]))).toBe(1)
  })

  it('handles an IFD0 offset pointing past the segment', () => {
    const app1 = exifApp1(6, { little: true })
    app1[14] = 0xff // IFD0 offset low byte -> far beyond the block
    expect(jpegOrientation(jpegWith([app1]))).toBe(1)
  })
})
