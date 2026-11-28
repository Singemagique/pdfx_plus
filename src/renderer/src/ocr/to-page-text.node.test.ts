import { degrees, PDFDocument } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import 'pdfjs-dist/legacy/build/pdf.worker.mjs'
import { describe, expect, it } from 'vitest'

import { pack, wordQuad, type OcrLine, type OcrPage } from '../../../shared/ocr/types'
import { buildPageText } from '../search/extract'
import { textMatchRects } from '../search/geometry'
import { handPage } from '../pdfx/test-utils/ocr-layer'
import { invertMatrix, ocrPageTextItems, overlayToUser } from './to-page-text'

const UPRIGHT = [1, 0, 0, -1, 0, 792]

const page = (lines: OcrLine[]): OcrPage => ({ ...handPage([]), lines })

describe('ocrPageTextItems', () => {
  it('one item per word, a space item between words, hasEOL at each line end', () => {
    const p = handPage([
      { y: 700, size: 10, x0: 72, words: [{ t: 'Hello', x: 0, w: 25 }, { t: 'world', x: 28, w: 26 }] }, // prettier-ignore
      { y: 686, size: 10, x0: 72, words: [{ t: 'again', x: 0, w: 25 }] }
    ])
    const items = ocrPageTextItems(pack(p), UPRIGHT, 792)
    expect(items.map((i) => [i.str, i.hasEOL])).toEqual([
      ['Hello', false],
      [' ', false],
      ['world', true],
      ['again', true]
    ])
    expect(items.every((i) => i.ocr)).toBe(true)
    // t = [s·cos, s·sin, −s·sin, s·cos, x, y] on an unrotated page; width = w; the em box.
    expect(items[0]).toMatchObject({ t: [10, 0, -0, 10, 72, 700], width: 25, height: 10, ascent: 0.8, descent: -0.2 }) // prettier-ignore
    // The space spans the gap: from the end of "Hello" to the start of "world".
    expect(items[1].t[4]).toBe(97)
    expect(items[1].width).toBe(3)
    expect(buildPageText(items, UPRIGHT).norm).toBe('hello world again')
  })

  it('writes no space between two CJK words, and one at every other boundary', () => {
    const p = handPage([
      {
        y: 700,
        size: 16,
        words: [
          { t: '東京', x: 0, w: 32 },
          { t: '都庁', x: 33, w: 32 },
          { t: 'PDFx', x: 70, w: 30 },
          { t: 'は', x: 104, w: 16 },
          { t: '한국어', x: 124, w: 48 },
          { t: '문서', x: 176, w: 32 }
        ]
      }
    ])
    const strs = ocrPageTextItems(pack(p), UPRIGHT, 792).map((i) => i.str)
    // Kana next to Hangul (Korean mixed with Hanja/kana) also joins; Hangul words keep theirs.
    expect(strs).toEqual(['東京', '都庁', ' ', 'PDFx', ' ', 'は', '한국어', ' ', '문서'])
  })

  it('carries a rotated line in its t (pdf.js user space, the design formula)', () => {
    const a = 0.3
    const p = page([{ angle: a, size: 12, words: [{ t: 'tilted', x: 100, y: 300, w: 40, conf: 90, confCal: 0.9 }] }]) // prettier-ignore
    const [it0] = ocrPageTextItems(pack(p), UPRIGHT, 792)
    const s = 12
    const f = (v: number): number => Math.fround(v) // Float32 geometry
    expect(it0.t[0]).toBeCloseTo(s * Math.cos(f(a)), 5)
    expect(it0.t[1]).toBeCloseTo(s * Math.sin(f(a)), 5)
    expect(it0.t[2]).toBeCloseTo(-s * Math.sin(f(a)), 5)
    expect(it0.t[3]).toBeCloseTo(s * Math.cos(f(a)), 5)
    expect(it0.t.slice(4)).toEqual([100, 300])
  })

  it('skips what the layer skips: empty after cleaning, no advance, non-finite, size 0', () => {
    const p = page([
      {
        angle: 0,
        size: 10,
        words: [
          { t: '​', x: 0, y: 700, w: 10, conf: null, confCal: null },
          { t: 'ok', x: 20, y: 700, w: 10, conf: null, confCal: null },
          { t: 'flat', x: 40, y: 700, w: 0, conf: null, confCal: null },
          { t: 'nan', x: NaN, y: 700, w: 10, conf: null, confCal: null },
          { t: 'ﬁne', x: 60, y: 700, w: 15, conf: null, confCal: null }
        ]
      },
      { angle: 0, size: 0, words: [{ t: 'unsized', x: 0, y: 600, w: 10, conf: null, confCal: null }] } // prettier-ignore
    ])
    const strs = ocrPageTextItems(pack(p), UPRIGHT, 792).map((i) => i.str)
    // Ligatures expanded exactly as the layer writes them.
    expect(strs).toEqual(['ok', ' ', 'fine'])
  })

  it('attaches the word’s char edges when they still fit its text', () => {
    const chars = new Float32Array([0, 14, 17, 21, 33, 40])
    const p = page([
      {
        angle: 0,
        size: 10,
        words: [
          { t: 'Wilma', x: 0, y: 700, w: 40, conf: 90, confCal: 0.9, chars },
          // Cleaning changes the text ("ﬁ" → "fi"): the edges no longer map, so none.
          { t: 'ﬁt', x: 50, y: 700, w: 12, conf: 90, confCal: 0.9, chars: new Float32Array([0, 8, 12]) }, // prettier-ignore
          // Too few edges for the text: none.
          { t: 'abc', x: 70, y: 700, w: 15, conf: 90, confCal: 0.9, chars: new Float32Array([0, 15]) } // prettier-ignore
        ]
      }
    ])
    const items = ocrPageTextItems(pack(p), UPRIGHT, 792).filter((i) => i.str.trim())
    expect(Array.from(items[0].charEdges!)).toEqual([0, 14, 17, 21, 33, 40])
    expect(items[1].charEdges).toBeUndefined()
    expect(items[2].charEdges).toBeUndefined()
  })

  it.each([0, 90, 180, 270])(
    'a word’s Find box is its overlay-frame em box on a /Rotate %i page with an offset CropBox',
    async (rotate) => {
      const doc = await PDFDocument.create()
      const pg = doc.addPage([600, 800])
      pg.setCropBox(30, 40, 500, 700)
      pg.setRotation(degrees(rotate))
      const pdf = await getDocument({ data: await doc.save(), verbosity: 0 }).promise
      const vp = (await pdf.getPage(1)).getViewport({ scale: 1 })
      await pdf.destroy()
      const vt = vp.transform as number[]
      const H = vp.height
      const line: OcrLine = { angle: 0.2, size: 14, words: [{ t: 'target', x: 120, y: 200, w: 50, conf: 90, confCal: 0.9 }] } // prettier-ignore
      const items = ocrPageTextItems(pack(page([line])), vt, H)
      const pt = buildPageText(items, vt)
      const [r] = textMatchRects(pt, 0, pt.norm.length)
      // The em box quad in the overlay frame, flipped to page px (top-left origin).
      const q = wordQuad(line.words[0], { angle: Math.fround(0.2), size: 14 })
      const xs = q.map((p) => p.x)
      const ys = q.map((p) => H - p.y)
      expect(r.x).toBeCloseTo(Math.min(...xs), 3)
      expect(r.y).toBeCloseTo(Math.min(...ys), 3)
      expect(r.x + r.w).toBeCloseTo(Math.max(...xs), 3)
      expect(r.y + r.h).toBeCloseTo(Math.max(...ys), 3)
    }
  )
})

describe('overlayToUser / invertMatrix', () => {
  it('inverts an affine', () => {
    const m = [0, 1, 1, 0, -40, -30]
    const inv = invertMatrix(m)
    const [x, y] = [7, 11]
    const u = [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
    expect(inv[0] * u[0] + inv[2] * u[1] + inv[4]).toBeCloseTo(x, 12)
    expect(inv[1] * u[0] + inv[3] * u[1] + inv[5]).toBeCloseTo(y, 12)
    expect(() => invertMatrix([0, 0, 0, 0, 0, 0])).toThrow()
  })

  it('is the identity for an unrotated page at the origin', () => {
    expect(overlayToUser(UPRIGHT, 792).map((v) => v + 0)).toEqual([1, 0, 0, 1, 0, 0])
  })
})
