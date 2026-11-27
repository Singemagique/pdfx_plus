import { describe, expect, it } from 'vitest'
import { buildPageText, type PageTextItem } from './extract'
import { mergeLineRects, overlayRect, textMatchRects, type PageRect } from './geometry'

/** pdf.js's viewport transform for an unrotated US Letter page at scale 1. */
const UPRIGHT = [1, 0, 0, -1, 0, 792]
/**
 * The same page with /Rotate 90 (what PageViewport computes: display x = user y, display y =
 * user x; the page is then 792 × 612).
 */
const ROTATE_90 = [0, 1, 1, 0, 0, 0]

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
