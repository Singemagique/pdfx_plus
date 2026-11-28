// The pure triage rules (DESIGN.md §3.4.1, §3.4.3): the classifier in the design's order and at
// its thresholds, broken-text detection, the geometry helpers (matrix composition, effective
// density, the exact union area, the overlay frame and the band), the DPI table on the worked
// examples, the JPX SIZ pre-check and the /ColorSpace reader.

import { describe, expect, it } from 'vitest'

import {
  DPI_RULES,
  PIXEL_CAPS,
  TRIAGE_THRESHOLDS as T,
  bandFraction,
  classifyPage,
  effectiveDpi,
  emptyQuality,
  isBadChar,
  isBrokenText,
  isForeignGlyphlessFont,
  jpxPrecheck,
  makeByteFind,
  mulMatrix,
  readJpx,
  selectRenderDpi,
  streamColourComponents,
  tallyChar,
  toOverlayFrame,
  unionArea,
  type Matrix6,
  type PageSignals,
  type TextQuality
} from './triage'

const quality = (text: string): TextQuality => {
  const q = emptyQuality()
  for (const ch of text.replace(/\s+/g, '')) tallyChar(q, ch.codePointAt(0)!, false)
  return q
}

const ENGLISH =
  'The harbour office opens at seven and closes when the last ferry has docked tonight'

const sig = (over: Partial<PageSignals> = {}): PageSignals => ({
  encrypted: false,
  visible: 0,
  invisible: 0,
  cov: 0,
  textArea: 0,
  band: 0,
  pdfxOcrMark: false,
  pdfxOcrFont: false,
  quality: quality(ENGLISH),
  ...over
})

describe('classifyPage, in the design order', () => {
  it('encryption first, then our own layer, then the rest', () => {
    expect(classifyPage(sig({ encrypted: true, pdfxOcrMark: true, cov: 1 }))).toBe('protected')
    expect(classifyPage(sig({ pdfxOcrMark: true, cov: 1, invisible: 500 }))).toBe('ocr-ours')
    expect(classifyPage(sig({ pdfxOcrFont: true, cov: 1, invisible: 500 }))).toBe('ocr-ours')
  })

  it('no text at all: scanned from 5% image coverage, else blank', () => {
    expect(classifyPage(sig({ cov: T.scannedCov }))).toBe('scanned')
    expect(classifyPage(sig({ cov: T.scannedCov - 1e-9 }))).toBe('blank')
  })

  it('ocr-foreign needs 80% invisible chars AND half the page under images', () => {
    const base = { visible: 20, invisible: 80, cov: 0.5 }
    expect(classifyPage(sig(base))).toBe('ocr-foreign')
    expect(classifyPage(sig({ ...base, invisible: 79 }))).not.toBe('ocr-foreign')
    expect(classifyPage(sig({ ...base, cov: 0.49 }))).not.toBe('ocr-foreign')
  })

  it('broken text comes before the near-scanned and mixed rules', () => {
    const bad = quality('xqzt'.repeat(20))
    expect(classifyPage(sig({ visible: 80, cov: 1, textArea: 0.01, quality: bad }))).toBe(
      'broken-text'
    )
  })

  it('near-scanned: high coverage and ANY of small area, few chars or a narrow band', () => {
    const page = { cov: 0.75, visible: 300, textArea: 0.2, band: 0.9 }
    expect(classifyPage(sig(page))).toBe('mixed')
    expect(classifyPage(sig({ ...page, textArea: 0.029 }))).toBe('near-scanned')
    expect(classifyPage(sig({ ...page, visible: 39 }))).toBe('near-scanned')
    expect(classifyPage(sig({ ...page, band: 0.1 }))).toBe('near-scanned')
    expect(classifyPage(sig({ ...page, band: 0.1, cov: 0.749 }))).toBe('mixed')
  })

  it('mixed from 10% coverage, else text', () => {
    expect(classifyPage(sig({ visible: 500, textArea: 0.2, band: 0.8, cov: 0.1 }))).toBe('mixed')
    expect(classifyPage(sig({ visible: 500, textArea: 0.2, band: 0.8, cov: 0.099 }))).toBe('text')
  })
})

describe('isBrokenText', () => {
  it('flags Unicode-map errors and bad chars, but needs enough text to judge', () => {
    const q = { ...emptyQuality(), mapErrors: 3 }
    expect(isBrokenText({ visible: 30, invisible: 0, quality: q })).toBe(true)
    expect(isBrokenText({ visible: 31, invisible: 0, quality: { ...q, mapErrors: 2 } })).toBe(false)
    expect(isBrokenText({ visible: 19, invisible: 0, quality: { ...q, mapErrors: 19 } })).toBe(
      false
    )
    expect(
      isBrokenText({ visible: 20, invisible: 0, quality: { ...emptyQuality(), badChars: 2 } })
    ).toBe(true)
  })

  it('the vowel test is script-gated and only for enough Latin letters', () => {
    const v = (text: string): boolean =>
      isBrokenText({
        visible: text.replace(/\s/g, '').length,
        invisible: 0,
        quality: quality(text)
      })
    expect(v(ENGLISH)).toBe(false)
    expect(v('Jürgen übergibt Größe und Maß der Brücke an Frau Köhler und Herrn Weiß')).toBe(false)
    expect(v('Řidič přivezl čtyři žluté švestky a ještě dvě růže pro babičku')).toBe(false)
    // A font whose code points land on consonants only (a broken simple-font encoding).
    expect(v('Bcdf ghjk lmnp qrst vwxz Bcdf ghjk lmnp qrst vwxz Bcdf ghjk lmnp qrst vwxz')).toBe(
      true
    )
    // Too vowel-heavy is just as unnatural.
    expect(v('aeio uaei ouae ioua eiou aeio uaei ouae ioua eiou aeio uaei ouae ioua eiou')).toBe(
      true
    )
    // Greek and Cyrillic have no Latin vowels to count: never judged by the ratio.
    expect(v('Το λιμάνι ανοίγει στις επτά και κλείνει όταν δέσει το τελευταίο πλοίο')).toBe(false)
    expect(v('Портовая контора открывается в семь и закрывается после последнего парома')).toBe(
      false
    )
    // Numbers and codes are not letters.
    expect(v('INV-01OI3 2026-11-27 $1,234.56 0O1lI 445566 778899 112233 445566')).toBe(false)
  })

  it('counts the bad code points', () => {
    for (const cp of [0, 0xfffd, 0x01, 0x7f, 0x9f, 0xe000, 0xf8ff, 0xf0000])
      expect(isBadChar(cp)).toBe(true)
    for (const cp of [0x41, 0x09, 0xe9, 0x4e2d, 0x1f600]) expect(isBadChar(cp)).toBe(false)
  })

  it('knows the glyphless OCR fonts of other tools, subset tags included', () => {
    expect(isForeignGlyphlessFont('GlyphLessFont')).toBe(true)
    expect(isForeignGlyphlessFont('ABCDEF+GlyphLessFont')).toBe(true)
    expect(isForeignGlyphlessFont('Occulta')).toBe(true)
    expect(isForeignGlyphlessFont('Helvetica')).toBe(false)
    expect(isForeignGlyphlessFont('PDFxOCR-GlyphLess')).toBe(false)
  })
})

describe('geometry', () => {
  it('composes child × ancestors and derives d_eff from the placed edge lengths', () => {
    // PR0's nested case: the child's GetMatrix already holds the Form /Matrix 0.5.
    const child: Matrix6 = [250, 0, 0, 125, 0, 0]
    const form: Matrix6 = [1, 0, 0, 1, 100, 100]
    const full = mulMatrix(child, form)
    expect(full).toEqual([250, 0, 0, 125, 100, 100])
    expect(effectiveDpi({ width: 1000, height: 500 }, full)).toBeCloseTo(288, 9)
    // 90° placement [0 250 −125 0]: still 288, whichever way the edges point.
    expect(effectiveDpi({ width: 1000, height: 500 }, [0, 250, -125, 0, 300, 100])).toBeCloseTo(
      288,
      9
    )
    // A 200 × 100 dpi fax on Letter: max of the two.
    expect(effectiveDpi({ width: 1700, height: 1100 }, [612, 0, 0, 792, 0, 0])).toBeCloseTo(200, 9)
    expect(effectiveDpi({ width: 10, height: 10 }, [0, 0, 0, 0, 0, 0])).toBeNull()
  })

  it('unionArea is exact (against a brute-force grid)', () => {
    expect(unionArea([])).toBe(0)
    expect(
      unionArea([
        { x0: 0, y0: 0, x1: 10, y1: 10 },
        { x0: 5, y0: 5, x1: 15, y1: 15 }
      ])
    ).toBe(175)
    expect(unionArea([{ x0: -5, y0: -5, x1: 5, y1: 5 }], { x0: 0, y0: 0, x1: 100, y1: 100 })).toBe(
      25
    )
    // Random integer boxes on a 64 × 64 grid.
    let seed = 7
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31
      return seed % n
    }
    for (let trial = 0; trial < 20; trial++) {
      const rects = Array.from({ length: 30 }, () => {
        const x0 = rnd(60)
        const y0 = rnd(60)
        return { x0, y0, x1: x0 + 1 + rnd(20), y1: y0 + 1 + rnd(20) }
      })
      const clip = { x0: 0, y0: 0, x1: 64, y1: 64 }
      let brute = 0
      for (let x = 0; x < 64; x++)
        for (let y = 0; y < 64; y++)
          if (rects.some((r) => x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1)) brute++
      expect(unionArea(rects, clip)).toBe(brute)
    }
  })

  it('maps user space into the overlay frame for every /Rotate', () => {
    const box = { x0: 10, y0: 20, x1: 622, y1: 812 } // a 612 × 792 view box at (10, 20)
    const r = { x0: 10, y0: 802, x1: 110, y1: 812 } // a strip along the user-space top-left
    expect(toOverlayFrame(r, { box, quarterTurns: 0 })).toEqual({
      x0: 0,
      y0: 782,
      x1: 100,
      y1: 792
    })
    // /Rotate 90: user top → shown right; user left → shown top.
    expect(toOverlayFrame(r, { box, quarterTurns: 1 })).toEqual({
      x0: 782,
      y0: 512,
      x1: 792,
      y1: 612
    })
    expect(toOverlayFrame(r, { box, quarterTurns: 2 })).toEqual({ x0: 512, y0: 0, x1: 612, y1: 10 })
    expect(toOverlayFrame(r, { box, quarterTurns: 3 })).toEqual({ x0: 0, y0: 0, x1: 10, y1: 100 })
  })

  it('measures the band in the shown frame', () => {
    const box = { x0: 0, y0: 0, x1: 612, y1: 792 }
    const header = [{ x0: 36, y0: 770, x1: 576, y1: 780 }]
    expect(bandFraction(header, { box, quarterTurns: 0 })).toBeCloseTo(10 / 792, 9)
    // The same user-space strip is a tall column on a /Rotate 90 page.
    expect(bandFraction(header, { box, quarterTurns: 1 })).toBeCloseTo(540 / 612, 9)
    expect(bandFraction([], { box, quarterTurns: 0 })).toBe(0)
  })
})

describe('selectRenderDpi (§3.4.3 worked examples)', () => {
  const A4 = { width: 595.28, height: 841.89 }
  const LETTER = { width: 612, height: 792 }

  it('a 4032 × 3024 photo fitted to A4 renders at its native density, ~4,032 px wide', () => {
    const dEff = (4032 * 72) / A4.width
    const c = selectRenderDpi({ page: A4, dEff, imageOrigin: true })
    expect(c.renderDpi).toBeCloseTo(487.68, 2)
    expect(Math.abs(c.width - 4032)).toBeLessThanOrEqual(1)
    expect(c.capped).toEqual([])
  })

  it('the same photo fitted to Letter: d_eff 474 → ~4,032 px', () => {
    const c = selectRenderDpi({ page: LETTER, dEff: (4032 * 72) / 612, imageOrigin: true })
    expect(c.renderDpi).toBeCloseTo(474.35, 2)
    expect(Math.abs(c.width - 4032)).toBeLessThanOrEqual(1)
  })

  it('a stand-alone import (1 px = 1 pt): 72 → 300, capped at 2× native, then by the pixel caps', () => {
    const page = { width: 4032, height: 3024 }
    const c = selectRenderDpi({ page, dEff: 72, imageOrigin: true })
    expect(c.capped).toEqual(['upsample', 'pixels'])
    // 2 × native = 144 DPI = 8,064 px wide; the 7,200 px side cap alone would give 7,200 × 5,400
    // = 38.9 MP, over the 36 MP area cap, which binds: 6,928 × 5,196 px at 123.71 DPI.
    expect(c.width).toBe(6928)
    expect(c.height).toBe(5196)
    expect(c.renderDpi).toBe(123.71)
    expect(Math.max(c.width, c.height)).toBeLessThanOrEqual(PIXEL_CAPS.maxLongSide)
    expect(c.width * c.height).toBeLessThanOrEqual(PIXEL_CAPS.maxPixels)
    // Without the area cap it is the design's 7,200 px.
    const sideOnly = selectRenderDpi({
      page,
      dEff: 72,
      imageOrigin: true,
      caps: { maxLongSide: 7200, maxPixels: Infinity }
    })
    expect(sideOnly.width).toBe(7200)
  })

  it('a small 1,000 px photo fitted to Letter: 300 would be 2,550 px, capped at 2,000 (~235 DPI)', () => {
    const c = selectRenderDpi({ page: LETTER, dEff: (1000 * 72) / 612, imageOrigin: true })
    expect(Math.abs(c.width - 2000)).toBeLessThanOrEqual(1)
    expect(c.renderDpi).toBeCloseTo(235.29, 2)
    expect(c.capped).toEqual(['upsample'])
  })

  it('photos between 300 and 600 keep their density; above, 600', () => {
    expect(selectRenderDpi({ page: LETTER, dEff: 450, imageOrigin: true }).renderDpi).toBe(450)
    expect(selectRenderDpi({ page: LETTER, dEff: 700, imageOrigin: true }).renderDpi).toBe(600)
  })

  it('scans: clamp(d_eff, 300, 400); a 2,480 px A4 scan at 300 stays 300', () => {
    expect(
      selectRenderDpi({ page: A4, dEff: (2480 * 72) / A4.width, imageOrigin: false })
    ).toMatchObject({
      renderDpi: 300,
      width: 2480,
      rule: 'scan'
    })
    expect(selectRenderDpi({ page: LETTER, dEff: 200, imageOrigin: false }).renderDpi).toBe(300)
    expect(selectRenderDpi({ page: LETTER, dEff: 360, imageOrigin: false }).renderDpi).toBe(360)
    expect(selectRenderDpi({ page: LETTER, dEff: 600, imageOrigin: false }).renderDpi).toBe(400)
    // No 2× cap for scans: a 72 dpi scan still renders at 300.
    expect(selectRenderDpi({ page: LETTER, dEff: 72, imageOrigin: false }).renderDpi).toBe(300)
  })

  it('no dominant image: 300', () => {
    expect(selectRenderDpi({ page: LETTER, dEff: null, imageOrigin: false })).toMatchObject({
      renderDpi: DPI_RULES.fallback,
      rule: 'fallback',
      width: 2550
    })
    expect(selectRenderDpi({ page: LETTER, dEff: null, imageOrigin: true }).renderDpi).toBe(300)
  })

  it('renderDpi is the final value: a huge scan page is brought under the caps', () => {
    const a0 = { width: 2383.94, height: 3370.39 }
    const c = selectRenderDpi({ page: a0, dEff: 300, imageOrigin: false })
    expect(c.renderDpi).toBeLessThan(300)
    expect(c.capped).toEqual(['pixels'])
    expect(Math.max(c.width, c.height)).toBeLessThanOrEqual(7200)
  })
})

// ---------------------------------------------------------------------------------------------

function siz(comps: Array<[number, number]>, w = 64, h = 32, bits = 8): Uint8Array {
  const c = comps.length
  const b = new Uint8Array(2 + 4 + 38 + 3 * c)
  const dv = new DataView(b.buffer)
  dv.setUint16(0, 0xff4f)
  dv.setUint16(2, 0xff51)
  dv.setUint16(4, 38 + 3 * c)
  dv.setUint32(8, w)
  dv.setUint32(12, h)
  dv.setUint32(24, w)
  dv.setUint32(28, h)
  dv.setUint16(40, c)
  comps.forEach(([x, y], i) => {
    b[42 + 3 * i] = bits - 1
    b[43 + 3 * i] = x
    b[44 + 3 * i] = y
  })
  return b
}

function jp2Box(type: string, payload: Uint8Array, xl = false): Uint8Array {
  const head = new Uint8Array(xl ? 16 : 8)
  const dv = new DataView(head.buffer)
  if (xl) {
    dv.setUint32(0, 1)
    dv.setUint32(12, 16 + payload.length)
  } else dv.setUint32(0, 8 + payload.length)
  for (let i = 0; i < 4; i++) head[4 + i] = type.charCodeAt(i)
  const out = new Uint8Array(head.length + payload.length)
  out.set(head)
  out.set(payload, head.length)
  return out
}

const cat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

function jp2File(code: Uint8Array, colr: Uint8Array, xl = false): Uint8Array {
  return cat(
    jp2Box('jP  ', new Uint8Array([0x0d, 0x0a, 0x87, 0x0a])),
    jp2Box('ftyp', new TextEncoder().encode('jp2 \0\0\0\0jp2 ')),
    jp2Box('jp2h', cat(jp2Box('ihdr', new Uint8Array(14)), jp2Box('colr', colr))),
    jp2Box('jp2c', code, xl)
  )
}

const enumCs = (cs: number): Uint8Array => new Uint8Array([1, 0, 0, 0, 0, 0, cs])

function iccColr(sig: string): Uint8Array {
  const b = new Uint8Array(3 + 128)
  b[0] = 2
  for (let i = 0; i < 4; i++) b[3 + 16 + i] = sig.charCodeAt(i)
  return b
}

describe('JPX SIZ pre-check', () => {
  it('reads SIZ from a raw codestream', () => {
    expect(readJpx(siz([[1, 1]], 640, 480, 12))).toEqual({
      components: 1,
      width: 640,
      height: 480,
      bitsPerComponent: 12,
      subsampling: [[1, 1]],
      jp2ColourComponents: null
    })
  })

  it('reads the JP2 colr box (enumerated and ICC) and a jp2c with an XLBox', () => {
    const code = siz([
      [1, 1],
      [1, 1],
      [1, 1]
    ])
    expect(readJpx(jp2File(code, enumCs(16)))?.jp2ColourComponents).toBe(3)
    expect(readJpx(jp2File(code, enumCs(17)))?.jp2ColourComponents).toBe(1)
    expect(readJpx(jp2File(code, iccColr('CMYK')))?.jp2ColourComponents).toBe(4)
    expect(readJpx(jp2File(code, iccColr('GRAY'), true))?.components).toBe(3)
  })

  it('refuses malformed data, subsampling, mismatches and a missing colour space', () => {
    expect(jpxPrecheck(new Uint8Array([0xff, 0x4f, 0xff, 0x51]), 1)).toEqual({
      ok: false,
      reason: 'jpx-malformed'
    })
    const bad = siz([[1, 1]])
    bad[5] = 99 // Lsiz no longer matches Csiz
    expect(jpxPrecheck(bad, 1)).toMatchObject({ reason: 'jpx-malformed' })
    expect(jpxPrecheck(siz([[2, 2]]), 1)).toMatchObject({ reason: 'jpx-subsampled' })
    expect(
      jpxPrecheck(
        siz([
          [1, 1],
          [1, 2],
          [1, 1]
        ]),
        3
      )
    ).toMatchObject({ reason: 'jpx-subsampled' })
    expect(jpxPrecheck(siz([[1, 1]]), 3)).toMatchObject({ reason: 'jpx-components' })
    expect(jpxPrecheck(siz([[1, 1]]), null)).toMatchObject({ reason: 'jpx-no-colour-space' })
    // The PDF's colour space wins over the JP2 header.
    expect(jpxPrecheck(jp2File(siz([[1, 1]]), enumCs(16)), 1).ok).toBe(true)
    expect(jpxPrecheck(jp2File(siz([[1, 1]]), enumCs(17)), null).ok).toBe(true)
    expect(jpxPrecheck(jp2File(siz([[1, 1]]), enumCs(16)), null)).toMatchObject({
      reason: 'jpx-components'
    })
  })
})

describe('streamColourComponents: an image /ColorSpace from the file bytes', () => {
  const enc = (s: string): Uint8Array => new TextEncoder().encode(s)
  const DATA =
    'JPXDATA-0123456789abcdefghijklmnopqrstuvwxyz-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ-end'

  function file(dict: string, extra = ''): Uint8Array {
    return enc(
      `%PDF-1.7\n${extra}5 0 obj\n<< /Type /XObject /Subtype /Image ${dict} /Filter /JPXDecode /Length ${DATA.length} >>\nstream\r\n${DATA}\nendstream\nendobj\n`
    )
  }
  const read = (f: Uint8Array): ReturnType<typeof streamColourComponents> =>
    streamColourComponents(f, enc(DATA), makeByteFind(f))

  it('reads a direct family name, or null when the dictionary has none', () => {
    expect(read(file('/ColorSpace /DeviceGray'))).toBe(1)
    expect(read(file('/ColorSpace/DeviceRGB'))).toBe(3)
    expect(read(file('/ColorSpace /DeviceCMYK'))).toBe(4)
    expect(read(file('/Width 8'))).toBeNull()
  })

  it('reads arrays: Indexed, CalRGB, DeviceN, and ICCBased through references', () => {
    expect(read(file('/ColorSpace [/Indexed /DeviceRGB 255 <00ff>]'))).toBe(1)
    expect(read(file('/ColorSpace [/CalRGB << /WhitePoint [1 1 1] >>]'))).toBe(3)
    expect(read(file('/ColorSpace [/DeviceN [/Cyan /Black] /DeviceCMYK 9 0 R]'))).toBe(2)
    const icc =
      '12 0 obj\n<< /N 3 /Alternate /DeviceRGB /Length 0 >>\nstream\n\nendstream\nendobj\n'
    expect(read(file('/ColorSpace [/ICCBased 12 0 R]', icc))).toBe(3)
    // An indirect colour space array whose number is a suffix of another object's.
    const arr = '112 0 obj\n[/DeviceGray]\nendobj\n7 0 obj\n[/ICCBased 12 0 R]\nendobj\n'
    expect(read(file('/ColorSpace 7 0 R', arr + icc))).toBe(3)
    expect(read(file('/ColorSpace 2 0 R', arr))).toBe('unknown')
  })

  it('is "unknown" when the stream is not in the file as raw bytes', () => {
    const f = file('/ColorSpace /DeviceGray')
    expect(streamColourComponents(f, enc('not-in-the-file-at-all'), makeByteFind(f))).toBe(
      'unknown'
    )
  })

  it('makeByteFind finds every occurrence from a start offset', () => {
    const hay = enc('abcabcabd')
    const find = makeByteFind(hay)
    expect(find(enc('abd'), 0)).toBe(6)
    expect(find(enc('abc'), 1)).toBe(3)
    expect(find(enc('zzz'), 0)).toBe(-1)
  })
})
