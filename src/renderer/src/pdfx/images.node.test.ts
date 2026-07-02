import { describe, expect, it } from 'vitest'

import { jpegSize } from './images'

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
