import { describe, expect, it } from 'vitest'
import { buildPageText, type PageTextItem } from './extract'
import {
  charWeight,
  mergeLineRects,
  overlayRect,
  sliceItem,
  textMatchRects,
  type PageRect
} from './geometry'

/** pdf.js's viewport transform for an unrotated US Letter page at scale 1. */
const UPRIGHT = [1, 0, 0, -1, 0, 792]
/**
 * The same page with /Rotate 90 (what PageViewport computes: display x = user y, display y =
 * user x; the page is then 792 × 612).
 */
const ROTATE_90 = [0, 1, 1, 0, 0, 0]

/**
 * A text item. Monospaced by default, so the transform tests below can use an exact even split;
 * the weighted split for proportional fonts has its own tests.
 */
function item(
  str: string,
  t: number[],
  width: number,
  extra: Partial<PageTextItem> = {}
): PageTextItem {
  return {
    str,
    t: t as PageTextItem['t'],
    width,
    height: Math.hypot(t[2], t[3]),
    ascent: 0.8,
    descent: -0.2,
    vertical: false,
    rtl: false,
    mono: true,
    hasEOL: false,
    ...extra
  }
}

const close = (r: PageRect, e: PageRect, digits = 4): void => {
  expect(r.x).toBeCloseTo(e.x, digits)
  expect(r.y).toBeCloseTo(e.y, digits)
  expect(r.w).toBeCloseTo(e.w, digits)
  expect(r.h).toBeCloseTo(e.h, digits)
}

const range = (norm: string, word: string): [number, number] => {
  const i = norm.indexOf(word)
  expect(i).toBeGreaterThanOrEqual(0)
  return [i, i + word.length]
}

describe('textMatchRects', () => {
  // "Hello World": 11 chars, 12 pt, 66 user units wide, baseline at y = 700.
  const hello = item('Hello World', [12, 0, 0, 12, 100, 700], 66)

  it('boxes a whole horizontal item in page px (y flipped)', () => {
    const pt = buildPageText([hello], UPRIGHT)
    const [rect] = textMatchRects(pt, 0, pt.norm.length)
    close(rect, { x: 100, y: 792 - 700 - 9.6, w: 66, h: 12 })
  })

  it('splits an item proportionally per character', () => {
    const pt = buildPageText([hello], UPRIGHT)
    const [s, e] = range(pt.norm, 'world')
    const [rect] = textMatchRects(pt, s, e)
    close(rect, { x: 100 + 36, y: 82.4, w: 30, h: 12 })
  })

  it('splits right-to-left items from the right edge', () => {
    const pt = buildPageText([item('abcdef', [10, 0, 0, 10, 0, 100], 60, { rtl: true })], UPRIGHT)
    const [rect] = textMatchRects(pt, 0, 2)
    close(rect, { x: 40, y: 792 - 100 - 8, w: 20, h: 10 })
  })

  it('applies an intrinsic /Rotate 90 through the viewport transform', () => {
    const pt = buildPageText([hello], ROTATE_90)
    const [s, e] = range(pt.norm, 'world')
    const [rect] = textMatchRects(pt, s, e)
    // Display x = user y (the glyph box spans 697.6 … 709.6), display y = user x.
    close(rect, { x: 697.6, y: 136, w: 12, h: 30 })
  })

  it('boxes text rotated by its own transform as an axis-aligned bound', () => {
    // 90° counter-clockwise text: the baseline runs up the page.
    const pt = buildPageText([item('abcd', [0, 10, -10, 0, 200, 300], 40)], UPRIGHT)
    const [rect] = textMatchRects(pt, 0, 4)
    // Along = (0, 1), up = (-1, 0): x spans 200 - 8 … 200 + 2, y spans 300 … 340.
    close(rect, { x: 192, y: 792 - 340, w: 10, h: 40 })
  })

  it('merges a match spanning items on one line into one rect', () => {
    const pt = buildPageText(
      [item('Hel', [10, 0, 0, 10, 50, 500], 15), item('lo there', [10, 0, 0, 10, 65, 500], 40)],
      UPRIGHT
    )
    expect(pt.norm).toBe('hello there')
    const rects = textMatchRects(pt, 0, 5)
    expect(rects).toHaveLength(1)
    // "Hel" (15) plus "lo" — 2 of the second item's 8 chars over its 40 units.
    close(rects[0], { x: 50, y: 792 - 500 - 8, w: 15 + 10, h: 10 })
  })

  it('gives one rect per line for a match across a line break', () => {
    const pt = buildPageText(
      [
        item('an exam-', [10, 0, 0, 10, 50, 500], 40, { hasEOL: true }),
        item('ple here', [10, 0, 0, 10, 50, 486], 40)
      ],
      UPRIGHT
    )
    expect(pt.norm).toBe('an example here')
    const [s, e] = range(pt.norm, 'example')
    const rects = textMatchRects(pt, s, e)
    expect(rects).toHaveLength(2)
    expect(rects[0].y).toBeLessThan(rects[1].y)
    // First line: "exam" (the joined hyphen's glyph is not part of the match), second: "ple".
    close(rects[0], { x: 50 + 15, y: 792 - 500 - 8, w: 20, h: 10 })
    close(rects[1], { x: 50, y: 792 - 486 - 8, w: 15, h: 10 })
  })

  describe('proportional fonts', () => {
    // Helvetica advances (1/1000 em) for the characters used below, from the standard-14 metrics.
    const HELV: Record<string, number> = {
      ' ': 278,
      a: 556,
      c: 500,
      e: 556,
      f: 278,
      g: 556,
      i: 222,
      l: 222,
      n: 556,
      o: 556,
      r: 333,
      t: 278,
      u: 556,
      A: 667,
      E: 667,
      I: 278,
      N: 722,
      V: 667
    }
    const advance = (s: string, size: number): number =>
      (Array.from(s.normalize('NFD').replace(/\p{M}/gu, '')).reduce((w, ch) => w + HELV[ch], 0) *
        size) /
      1000
    /** A Helvetica line at 12 pt, as pdf.js reports it: one item, one advance for the whole run. */
    const line = (s: string): PageTextItem =>
      item(s, [12, 0, 0, 12, 100, 700], advance(s, 12), { mono: false })

    it('places a word inside a one-item line at its glyphs, not an even split', () => {
      const s = 'NAIVE garcon'
      const pt = buildPageText([line(s)], UPRIGHT)
      const [a, b] = range(pt.norm, 'garcon')
      const [rect] = textMatchRects(pt, a, b)
      // The capitals are wide: an even split would start "garcon" ~7 px early.
      expect(rect.x).toBeCloseTo(100 + advance('NAIVE ', 12), 3)
      expect(rect.w).toBeCloseTo(advance('garcon', 12), 3)
    })

    it('weights an accented letter as its base letter', () => {
      const s = 'le café au lait'
      const pt = buildPageText([line(s)], UPRIGHT)
      const [a, b] = range(pt.norm, 'cafe')
      const [rect] = textMatchRects(pt, a, b)
      expect(rect.x).toBeCloseTo(100 + advance('le ', 12), 3)
      expect(rect.w).toBeCloseTo(advance('café', 12), 3)
      // A single letter lands on its own glyph.
      const i = pt.norm.indexOf('a', a)
      const [one] = textMatchRects(pt, i, i + 1)
      expect(one.x).toBeCloseTo(100 + advance('le c', 12), 3)
      expect(one.w).toBeCloseTo(advance('a', 12), 3)
    })

    it('splits a monospaced item evenly', () => {
      const pt = buildPageText([item('mmii', [10, 0, 0, 10, 0, 100], 24, { mono: true })], UPRIGHT)
      const [rect] = textMatchRects(pt, 2, 4)
      close(rect, { x: 12, y: 792 - 100 - 8, w: 12, h: 10 })
    })

    it('gives marks and low surrogates no width of their own', () => {
      expect(charWeight('e\u0301', 1)).toBe(0)
      expect(charWeight('\u{1d400}', 1)).toBe(0)
      expect(charWeight('é', 0)).toBe(charWeight('e', 0))
      expect(charWeight('漢', 0)).toBe(1000)
    })
  })

  it('is empty for an empty page text', () => {
    expect(textMatchRects(buildPageText([], UPRIGHT), 0, 3)).toEqual([])
  })
})

describe('buildPageText', () => {
  it('flags a line change that pdf.js left without hasEOL', () => {
    const pt = buildPageText(
      [item('exam-', [10, 0, 0, 10, 50, 500], 25), item('ple', [10, 0, 0, 10, 50, 486], 15)],
      UPRIGHT
    )
    expect(pt.norm).toBe('example')
  })

  it('does not break a line for a superscript', () => {
    const pt = buildPageText(
      [item('x', [10, 0, 0, 10, 50, 500], 5), item('2', [6, 0, 0, 6, 55, 504], 3)],
      UPRIGHT
    )
    expect(pt.norm).toBe('x2')
  })
})

describe('mergeLineRects', () => {
  it('leaves rects far apart on a line separate', () => {
    expect(
      mergeLineRects([
        { x: 0, y: 0, w: 10, h: 10 },
        { x: 100, y: 0, w: 10, h: 10 }
      ])
    ).toHaveLength(2)
  })
})

describe('overlayRect', () => {
  it('flips the overlay box to a top-left origin', () => {
    expect(overlayRect({ x: 10, y: 700, w: 100, h: 20, rotation: 0, opacity: 1 }, 792)).toEqual({
      x: 10,
      y: 72,
      w: 100,
      h: 20
    })
  })
})

describe('charEdges (OCR words): exact partial-word highlights', () => {
  // "Wilma" as an OCR word: 40 pt wide, with a wide W and a narrow i (edges per code point).
  const edges = [0, 20, 22, 25, 34, 40]
  const wilma = item('Wilma', [10, 0, 0, 10, 100, 700], 40, { mono: false, charEdges: edges })

  it('places a slice exactly on its edges instead of the Helvetica estimate', () => {
    const pt = buildPageText([wilma], UPRIGHT)
    const [ilm] = textMatchRects(pt, 1, 4)
    close(ilm, { x: 120, y: 792 - 708, w: 14, h: 10 })
    const [a] = textMatchRects(pt, 4, 5)
    close(a, { x: 134, y: 792 - 708, w: 6, h: 10 })
    // Without edges, the same slice falls elsewhere (the weighted estimate).
    const est = buildPageText([{ ...wilma, charEdges: undefined }], UPRIGHT)
    expect(Math.abs(textMatchRects(est, 1, 4)[0].x - 120)).toBeGreaterThan(1)
  })

  it('follows a rotated baseline', () => {
    const pt = buildPageText([{ ...wilma, t: [0, 10, -10, 0, 100, 400] }], UPRIGHT)
    // Running up the page from (100, 400): "ilm" covers user y 420..434.
    const [r] = textMatchRects(pt, 1, 4)
    close(r, { x: 100 - 8, y: 792 - 434, w: 10, h: 14 })
  })

  it('counts edges per code point (a surrogate pair is one character)', () => {
    const w = item('𝐀bc', [10, 0, 0, 10, 0, 700], 30, { mono: false, charEdges: [0, 20, 25, 30] })
    const pt = buildPageText([w], UPRIGHT)
    const at = pt.norm.indexOf('b')
    close(textMatchRects(pt, at, at + 1)[0], { x: 20, y: 792 - 708, w: 5, h: 10 })
  })

  it('ignores edges that do not fit the text', () => {
    const bad = item('Wilma', [10, 0, 0, 10, 100, 700], 40, { mono: true, charEdges: [0, 10, 40] })
    const pt = buildPageText([bad], UPRIGHT)
    close(textMatchRects(pt, 1, 4)[0], { x: 108, y: 792 - 708, w: 24, h: 10 })
  })
})

describe('sliceItem', () => {
  it('moves the origin along a rotated baseline and keeps the advance proportional', () => {
    const a = Math.PI / 4
    const it0 = item('abcdef', [10 * Math.cos(a), 10 * Math.sin(a), -10 * Math.sin(a), 10 * Math.cos(a), 0, 0], 30) // prettier-ignore
    const s = sliceItem(it0, 2, 4)
    expect(s.str).toBe('cd')
    expect(s.width).toBeCloseTo(10, 9)
    expect(s.t[4]).toBeCloseTo(10 * Math.cos(a), 9)
    expect(s.t[5]).toBeCloseTo(10 * Math.sin(a), 9)
  })

  it('slices charEdges along, rebased to 0', () => {
    const it0 = item('Wilma', [10, 0, 0, 10, 100, 700], 40, { mono: false, charEdges: [0, 20, 22, 25, 34, 40] }) // prettier-ignore
    const s = sliceItem(it0, 1, 4)
    expect(s.t[4]).toBe(120)
    expect(s.width).toBe(14)
    expect(Array.from(s.charEdges!)).toEqual([0, 2, 5, 14])
  })
})
