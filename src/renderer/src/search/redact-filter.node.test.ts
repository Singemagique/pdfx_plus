import { describe, expect, it } from 'vitest'
import { buildPageText, type PageTextItem } from './extract'
import { textMatchRects, type PageRect } from './geometry'
import { filterRedacted } from './redact-filter'

/** An unrotated US Letter page (pdf.js viewport transform at scale 1). */
const VT = [1, 0, 0, -1, 0, 792]
/** /Rotate 90: display x = user y, display y = user x (the page is then 792 × 612). */
const ROTATE_90 = [0, 1, 1, 0, 0, 0]

/** A monospaced 10 pt item at (x, 700): 5 pt per character, so boxes are exact. */
function item(str: string, x = 50, extra: Partial<PageTextItem> = {}): PageTextItem {
  return {
    str,
    t: [10, 0, 0, 10, x, 700],
    width: str.length * 5,
    height: 10,
    ascent: 0.8,
    descent: -0.2,
    vertical: false,
    rtl: false,
    mono: true,
    hasEOL: false,
    ...extra
  }
}

/** Page-px box of characters [lo, hi) of an `item` at x (upright page). */
const charsBox = (lo: number, hi: number, x = 50): PageRect => ({
  x: x + 5 * lo,
  y: 792 - 708,
  w: 5 * (hi - lo),
  h: 10
})

const strs = (items: readonly PageTextItem[]): string[] => items.map((i) => i.str)
const norm = (items: readonly PageTextItem[], vt = VT): string => buildPageText(items, vt).norm

describe('filterRedacted: native (pdf.js) items', () => {
  it('returns the very same items when nothing is touched', () => {
    const items = [item('far away text', 50, { hasEOL: true })]
    expect(filterRedacted(items, null, VT)).toBe(items)
    expect(filterRedacted(items, [], VT)).toBe(items)
    expect(filterRedacted(items, [{ x: 400, y: 84, w: 50, h: 10 }], VT)).toBe(items)
    // A zero-area box drops nothing (as mirror.ts's strict overlap test).
    expect(filterRedacted(items, [{ x: 60, y: 84, w: 0, h: 10 }], VT)).toBe(items)
  })

  it('splits an item around the redacted characters, never mutating it', () => {
    const it0 = item('Hello  secret  world', 50, { hasEOL: true })
    const before = JSON.stringify(it0)
    const out = filterRedacted([it0], [charsBox(7, 13)], VT)
    expect(strs(out)).toEqual(['Hello  ', ' ', 'world'])
    expect(out.map((i) => i.hasEOL)).toEqual([false, false, true])
    // Each piece sits where its characters were, with its own advance (the removed run took the
    // spaces after it).
    expect(out.map((i) => [i.t[4], i.width])).toEqual([
      [50, 35],
      [85, 40],
      [125, 25]
    ])
    expect(JSON.stringify(it0)).toBe(before)
    expect(norm(out)).toBe('hello world')
    // Highlights on the pieces land where the words were drawn.
    const pt = buildPageText(out, VT)
    const at = pt.norm.indexOf('world')
    const [r] = textMatchRects(pt, at, at + 5)
    expect(r.x).toBeCloseTo(125, 6)
    expect(r.w).toBeCloseTo(25, 6)
  })

  it('pads by one average character width along the run: a facing neighbour character goes', () => {
    const out = filterRedacted([item('ab secret cd')], [charsBox(3, 9)], VT)
    expect(norm(out)).toBe('a d')
  })

  it('a redaction that misses the glyphs by more than the pad leaves the item alone', () => {
    const items = [item('words')]
    // 1.5 pt above the ascent (pad = max(1, 0.15 × 10) = 1.5): just clear.
    expect(filterRedacted(items, [{ x: 50, y: 792 - 708 - 1.5 - 5, w: 25, h: 5 }], VT)).toBe(items)
    // 1 pt above: touches the padded box.
    expect(norm(filterRedacted(items, [{ x: 50, y: 792 - 708 - 6, w: 25, h: 5 }], VT))).toBe('')
  })

  it('keeps the line break of a fully redacted line end', () => {
    const items = [item('first line', 50, { hasEOL: true }), item('second', 50, { t: [10, 0, 0, 10, 50, 680] })] // prettier-ignore
    const out = filterRedacted(items, [charsBox(6, 10)], VT)
    expect(strs(out)).toEqual(['firs', ' ', 'second'])
    expect(out[0].hasEOL).toBe(false)
    expect(out[1].hasEOL).toBe(true)
    expect(norm(out)).toBe('firs second')
  })

  it('handles negative-size boxes (drawn right to left)', () => {
    const b = charsBox(7, 13)
    const out = filterRedacted([item('Hello  secret  world')], [{ x: b.x + b.w, y: b.y + b.h, w: -b.w, h: -b.h }], VT) // prettier-ignore
    expect(norm(out)).toBe('hello world')
  })

  it('slices on a page with an intrinsic /Rotate (boxes in its display frame)', () => {
    // User (x, 700) → display (700, x): the run goes down the page.
    const it0 = item('Hello  secret  world')
    const box: PageRect = { x: 698, y: 50 + 35, w: 10, h: 30 }
    expect(norm(filterRedacted([it0], [box], ROTATE_90), ROTATE_90)).toBe('hello world')
  })

  it('slices a rotated (non-axis-aligned) item along its own baseline', () => {
    const a = Math.PI / 6
    const t: PageTextItem['t'] = [10 * Math.cos(a), 10 * Math.sin(a), -10 * Math.sin(a), 10 * Math.cos(a), 50, 600] // prettier-ignore
    const it0 = item('Hello  secret  world', 50, { t })
    // A small box on the baseline under the middle of "secret" (chars 7..13, 35..65 pt along).
    const mid = 50
    const p = { x: 50 + mid * Math.cos(a), y: 792 - (600 + mid * Math.sin(a)) }
    const out = filterRedacted([it0], [{ x: p.x - 1, y: p.y - 3, w: 2, h: 2 }], VT)
    expect(norm(out)).not.toContain('secret')
    expect(norm(out)).toContain('hello')
    expect(norm(out)).toContain('world')
  })

  it('drops an item it cannot slice (no advance) whole, but only when its estimated box is hit', () => {
    const a = Math.PI / 6
    const t: PageTextItem['t'] = [10 * Math.cos(a), 10 * Math.sin(a), -10 * Math.sin(a), 10 * Math.cos(a), 50, 600] // prettier-ignore
    const it0 = item('tilted words', 50, { t, width: 0, hasEOL: true })
    const near = { x: 60, y: 792 - 610, w: 5, h: 5 }
    const out = filterRedacted([it0], [near], VT)
    expect(strs(out)).toEqual([' '])
    expect(out[0].hasEOL).toBe(true)
    const items = [it0]
    expect(filterRedacted(items, [{ x: 500, y: 100, w: 10, h: 10 }], VT)).toBe(items)
  })

  it('slices a vertical run by its height', () => {
    const v = item('abcdef', 100, { vertical: true, width: 10, height: 60, t: [10, 0, 0, 10, 100, 700] }) // prettier-ignore
    // The run reads down from y = 700: "cd" is user y 680..660 → display 112..132.
    const out = filterRedacted([v], [{ x: 102, y: 792 - 678, w: 6, h: 16 }], VT)
    expect(norm(out)).toBe('a f')
  })
})

describe('filterRedacted: OCR items', () => {
  const ocr = (str: string, x: number, extra: Partial<PageTextItem> = {}): PageTextItem =>
    item(str, x, { mono: false, ocr: true, ...extra })
  const line = [
    ocr('visible', 100),
    ocr(' ', 135, { width: 3 }),
    ocr('hidden', 138),
    ocr(' ', 168, { width: 3 }),
    ocr('word', 171, { hasEOL: true })
  ]

  it('drops the whole word when any part of its footprint is touched', () => {
    const out = filterRedacted(line, [{ x: 166, y: 86, w: 1, h: 1 }], VT) // the last "n"
    expect(norm(out)).toBe('visible word')
    expect(strs(out)).toEqual(['visible', ' ', ' ', ' ', 'word'])
  })

  it('reaches max(1 pt, 0.15 × size) past the em box, no further', () => {
    // 1.4 pt right of "word"'s end (191): inside the 1.5 pt pad.
    expect(norm(filterRedacted(line, [{ x: 192.4, y: 86, w: 2, h: 2 }], VT))).toBe('visible hidden')
    // 1.6 pt: outside.
    expect(filterRedacted(line, [{ x: 192.6, y: 86, w: 2, h: 2 }], VT)).toBe(line)
  })

  it('keeps the line end of a dropped last word', () => {
    const out = filterRedacted(line, [{ x: 175, y: 86, w: 2, h: 2 }], VT)
    expect(out[out.length - 1]).toMatchObject({ str: ' ', hasEOL: true })
  })

  it('never splits an OCR word, even a long one', () => {
    const long = [ocr('supercalifragilistic', 100, { hasEOL: true })]
    expect(strs(filterRedacted(long, [{ x: 100, y: 86, w: 2, h: 2 }], VT))).toEqual([' '])
  })
})
