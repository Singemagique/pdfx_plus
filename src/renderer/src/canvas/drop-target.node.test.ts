import { describe, expect, it } from 'vitest'
import {
  BASE_PAGE_HEIGHT,
  CARD_PAD_X,
  DOC_GAP_Y,
  PAGE_GAP,
  PAGES_TOP,
  ROW_GAP,
  computeLayout
} from './layout'
import { betweenSlotY, computeDropTarget } from './drop-target'
import { makePageKey } from '../edit/model'
import { LANDSCAPE, WRAP_5, doc, page } from './test-utils/layout-fixtures'

const ROW_PITCH = BASE_PAGE_HEIGHT + ROW_GAP
const LETTER_W = 216
const rowMid = (docY: number, row: number): number =>
  docY + PAGES_TOP + row * ROW_PITCH + BASE_PAGE_HEIGHT / 2
/** x of the centre of the n-th letter page in a row. */
const centreX = (n: number): number => CARD_PAD_X + n * (LETTER_W + PAGE_GAP) + LETTER_W / 2

// 12 letter pages at a five-page wrap: rows of 5 / 5 / 2 (+ add-page).
const layout = computeLayout([doc('a', 12), doc('b', 1)], undefined, WRAP_5)
const [a, b] = layout.items

const into = (x: number, y: number, exclude: string | null = null): unknown =>
  computeDropTarget(layout, x, y, 1, exclude, true)

describe('computeDropTarget into a multi-row document', () => {
  it('picks the row by y and the slot by x', () => {
    expect(into(centreX(0) - 1, rowMid(a.y, 0))).toEqual({ kind: 'into', docId: 'a', index: 0 })
    expect(into(centreX(2) + 1, rowMid(a.y, 0))).toEqual({ kind: 'into', docId: 'a', index: 3 })
    expect(into(centreX(0) - 1, rowMid(a.y, 1))).toEqual({ kind: 'into', docId: 'a', index: 5 })
    expect(into(centreX(3) + 1, rowMid(a.y, 1))).toEqual({ kind: 'into', docId: 'a', index: 9 })
    expect(into(centreX(1) - 1, rowMid(a.y, 2))).toEqual({ kind: 'into', docId: 'a', index: 11 })
  })

  it('past the end of a row inserts after that row’s last page', () => {
    expect(into(WRAP_5 - 5, rowMid(a.y, 0))).toMatchObject({ index: 5 })
    expect(into(WRAP_5 - 5, rowMid(a.y, 1))).toMatchObject({ index: 10 })
    // The last row: beyond the final page (over the add-page slot) appends.
    expect(into(WRAP_5 - 5, rowMid(a.y, 2))).toMatchObject({ index: 12 })
  })

  it('treats the header band as the first row and splits row gaps in the middle', () => {
    expect(into(centreX(1) + 1, a.y + 5)).toMatchObject({ index: 2 })
    const gapMid = a.y + PAGES_TOP + BASE_PAGE_HEIGHT + ROW_GAP / 2
    expect(into(centreX(0) - 1, gapMid - 1)).toMatchObject({ index: 0 })
    expect(into(centreX(0) - 1, gapMid + 1)).toMatchObject({ index: 5 })
  })

  it('hit-tests against the layout re-flowed without the dragged page', () => {
    // Without a-p4, a-p5 moves up to the end of row 0, so the 2nd row starts at a-p6.
    expect(into(WRAP_5 - 5, rowMid(a.y, 0), 'a-p4')).toMatchObject({ index: 5 })
    expect(into(centreX(0) - 1, rowMid(a.y, 1), 'a-p4')).toMatchObject({ index: 5 })
    expect(into(centreX(4) + 1, rowMid(a.y, 1), 'a-p4')).toMatchObject({ index: 10 })
  })

  it('a drop on the row the add-page slot sits on alone appends', () => {
    // 10 pages fill two rows exactly, so the add-page slot opens a third row with no page in it.
    const full = computeLayout([doc('f', 10), doc('g', 1)], undefined, WRAP_5)
    const f = full.items[0]
    expect(f.rows).toBe(3)
    const at = (x: number, y: number): unknown => computeDropTarget(full, x, y, 1, null, true)
    const add = f.addPage
    expect(at(add.x + add.w / 2, add.y + add.h / 2)).toEqual({
      kind: 'into',
      docId: 'f',
      index: 10
    })
    expect(at(f.width - 5, rowMid(f.y, 2))).toMatchObject({ index: 10 })
    // Just below the middle of the gap above that row already counts as that row.
    expect(at(centreX(0), add.y - ROW_GAP / 2 + 1)).toMatchObject({ index: 10 })
    // The rows above are untouched.
    expect(at(centreX(0) - 1, rowMid(f.y, 1))).toMatchObject({ index: 5 })
  })

  it('a drop on a row emptied by the dragged page appends', () => {
    // 6 pages: 5 + 1 (+ add-page). Dragging a-p0 out pulls a-p5 up, emptying the second row.
    const six = computeLayout([doc('s', 6)], undefined, WRAP_5)
    const at = (x: number, y: number): unknown => computeDropTarget(six, x, y, 1, 's-p0', true)
    expect(at(CARD_PAD_X + 50, rowMid(0, 1))).toEqual({ kind: 'into', docId: 's', index: 5 })
    expect(at(CARD_PAD_X + 50, rowMid(0, 0))).toMatchObject({ index: 0 })
  })

  it('uses rotated page widths (the strip used to ignore rotation)', () => {
    const d = { id: 'r', name: 'r.pdf', pages: [page('l0', LANDSCAPE, 0), page('p1')] }
    const rotations = new Map([[makePageKey(d.pages[0].source.id, 0), 90]])
    const rl = computeLayout([d], { rotations }, WRAP_5)
    // l0 is drawn 216 wide, so p1 is centred at 22 + 216 + 18 + 108 = 364. Unrotated (362 wide)
    // math would have put p1's centre at 510 and called x = 380 "before p1".
    expect(computeDropTarget(rl, 380, rowMid(0, 0), 1, null, true)).toEqual({
      kind: 'into',
      docId: 'r',
      index: 2
    })
    expect(computeDropTarget(rl, 300, rowMid(0, 0), 1, null, true)).toMatchObject({ index: 1 })
  })

  it('uses cropped page widths: a cropped page is hit where it is drawn', () => {
    const d = { id: 'c', name: 'c.pdf', pages: [page('c0'), page('c1')] }
    // A square crop draws c0 280 wide, so c1 is centred at 22 + 280 + 18 + 108 = 428.
    const crops = new Map([[makePageKey(d.pages[0].source.id, 0), { x: 0, y: 0, w: 300, h: 300 }]])
    const cl = computeLayout([d], { crops }, WRAP_5)
    expect(cl.items[0].pages[0].w).toBe(BASE_PAGE_HEIGHT)
    // x = 400 is left of c1's centre (before c1); uncropped (216 wide) it would be past it.
    expect(computeDropTarget(cl, 400, rowMid(0, 0), 1, null, true)).toMatchObject({ index: 1 })
    expect(computeDropTarget(cl, 440, rowMid(0, 0), 1, null, true)).toMatchObject({ index: 2 })
    expect(computeDropTarget(cl, 140, rowMid(0, 0), 1, null, true)).toMatchObject({ index: 0 })
  })
})

describe('computeDropTarget between documents with variable heights', () => {
  it('a drop in the gap below a tall card goes between it and the next', () => {
    const y = a.y + a.height + DOC_GAP_Y / 2
    expect(into(100, y)).toEqual({ kind: 'between', docIndex: 1 })
  })

  it('anything inside a tall card (even its last row) is "into" it', () => {
    expect(into(100, a.y + a.height - 2)).toMatchObject({ kind: 'into', docId: 'a' })
    expect(into(100, rowMid(b.y, 0))).toMatchObject({ kind: 'into', docId: 'b', index: 0 })
  })

  it('with "into" disallowed, splits each card at its own half height', () => {
    const t = (y: number): unknown => computeDropTarget(layout, 100, y, 1, null, false)
    expect(t(a.y + a.height / 2 - 1)).toEqual({ kind: 'between', docIndex: 0 })
    expect(t(a.y + a.height / 2 + 1)).toEqual({ kind: 'between', docIndex: 1 })
    expect(t(b.y + b.height / 2 + 1)).toEqual({ kind: 'between', docIndex: 2 })
  })

  it('zoomed far out, every drop is between documents', () => {
    expect(computeDropTarget(layout, 100, rowMid(a.y, 0), 0.1, null, true)).toEqual({
      kind: 'between',
      docIndex: 0
    })
  })

  it('betweenSlotY follows the real card heights', () => {
    expect(betweenSlotY(layout, 0)).toBe(0)
    expect(betweenSlotY(layout, 1)).toBe(a.height + DOC_GAP_Y)
    expect(betweenSlotY(layout, 2)).toBe(b.y + b.height + DOC_GAP_Y)
    expect(betweenSlotY(computeLayout([]), 0)).toBe(0)
  })
})
