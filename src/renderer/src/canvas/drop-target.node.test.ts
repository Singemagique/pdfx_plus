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
import type { DropTarget, DropView } from './drop-target'
import { makePageKey } from '../edit/model'
import { LANDSCAPE, WRAP_5, doc, page } from './test-utils/layout-fixtures'

const ROW_PITCH = BASE_PAGE_HEIGHT + ROW_GAP
const LETTER_W = 216
const rowMid = (docY: number, row: number): number =>
  docY + PAGES_TOP + row * ROW_PITCH + BASE_PAGE_HEIGHT / 2
/** x of the centre of the n-th letter page in a row. */
const centreX = (n: number): number => CARD_PAD_X + n * (LETTER_W + PAGE_GAP) + LETTER_W / 2

// 12 letter pages at a five-page wrap: rows of 5 / 5 / 2 (+ add-page). a sets the card width, so its
// grid starts at the padding.
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

  it('a full last row gets no extra row; a drop by its add-page button appends', () => {
    // 10 pages fill two rows exactly: the card is two rows tall, the add-page slot a round button on
    // the right edge of the second row.
    const full = computeLayout([doc('f', 10), doc('g', 1)], undefined, WRAP_5)
    const [f, g] = full.items
    expect(f.rows).toBe(2)
    expect(f.addPage.edge).toBe(true)
    const at = (x: number, y: number): unknown => computeDropTarget(full, x, y, 1, null, true)
    const add = f.addPage
    expect(at(add.x + add.w / 2, add.y + add.h / 2)).toEqual({
      kind: 'into',
      docId: 'f',
      index: 10
    })
    expect(at(f.width - 5, rowMid(f.y, 1))).toMatchObject({ index: 10 })
    expect(at(centreX(0) - 1, rowMid(f.y, 1))).toMatchObject({ index: 5 })
    // Directly below the second row is the gap before the next document, not an empty row.
    expect(g.y).toBe(f.y + f.height + DOC_GAP_Y)
    expect(at(centreX(0), f.y + f.height + DOC_GAP_Y / 2)).toEqual({ kind: 'between', docIndex: 1 })
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
    const rl = computeLayout([d], rotations, WRAP_5)
    const gx = rl.items[0].gridX
    // l0 is drawn 216 wide, so p1 is centred at gx + 216 + 18 + 108 = gx + 342. Unrotated (362
    // wide) math would have put p1's centre at gx + 488 and called gx + 358 "before p1".
    expect(computeDropTarget(rl, gx + 358, rowMid(0, 0), 1, null, true)).toEqual({
      kind: 'into',
      docId: 'r',
      index: 2
    })
    expect(computeDropTarget(rl, gx + 278, rowMid(0, 0), 1, null, true)).toMatchObject({
      index: 1
    })
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

describe('computeDropTarget against an into-ghost that grew its card by a row', () => {
  // p's 5 letter pages fill its one row, so a landscape page dragged to its end wraps onto a second
  // row: the drag view draws p a row taller and q and r a row lower.
  const LANDSCAPE_W = 362
  const grown = computeLayout([doc('p', 5), doc('q', 2), doc('r', 1)], undefined, WRAP_5)
  const [p, q, r] = grown.items
  const target: DropTarget = { kind: 'into', docId: 'p', index: 5 }
  const view: DropView = { target, ghostWidth: LANDSCAPE_W }
  const hit = (x: number, y: number): DropTarget =>
    computeDropTarget(grown, x, y, 1, null, true, view)

  it('keeps the target while the pointer is on the ghost’s new row', () => {
    const ghostRow = rowMid(p.y, 1)
    // Hit-tested against the undrawn layout, this point is in q's card: the target used to flip.
    expect(computeDropTarget(grown, centreX(0), ghostRow, 1, null, true)).toMatchObject({
      kind: 'into',
      docId: 'q'
    })
    for (const x of [5, centreX(0), centreX(2), WRAP_5 - 5])
      expect(hit(x, ghostRow)).toEqual(target)
    expect(hit(centreX(0), p.y + p.height + 1)).toEqual(target)
    expect(hit(centreX(0), p.y + p.height + ROW_PITCH)).toEqual(target)
  })

  it('on the new row, moves a ghost opened mid-row to the end (where it lands under the pointer)', () => {
    // A ghost at index 1 also wraps p onto a second row, but holding p's displaced pages.
    const mid: DropView = {
      target: { kind: 'into', docId: 'p', index: 1 },
      ghostWidth: LANDSCAPE_W
    }
    const y = rowMid(p.y, 1)
    expect(computeDropTarget(grown, centreX(0), y, 1, null, true, mid)).toEqual(target)
    // …which is then a fixed point.
    expect(hit(centreX(0), y)).toEqual(target)
  })

  it('keeps the drawn target on the new row when an appended ghost would not open it', () => {
    // Rows [1100] [200]: a 300 ghost first wraps both pages down (3 rows); appended it fits beside
    // the 200 (2 rows), so moving it to the end would pull the row out from under the pointer.
    const d = {
      id: 'v',
      name: 'v.pdf',
      pages: [page('big', { width: 1100, height: 280 }), page('small', { width: 200, height: 280 })]
    }
    const l = computeLayout([d, doc('z', 1)], undefined, WRAP_5)
    const v = l.items[0]
    expect(v.rows).toBe(2)
    const first: DropView = { target: { kind: 'into', docId: 'v', index: 0 }, ghostWidth: 300 }
    expect(computeDropTarget(l, 100, rowMid(v.y, 2), 1, null, true, first)).toEqual(first.target)
  })

  it('still picks the index from the pages on the card’s own rows', () => {
    expect(hit(centreX(0) - 1, rowMid(p.y, 0))).toEqual({ kind: 'into', docId: 'p', index: 0 })
    expect(hit(centreX(3) + 1, rowMid(p.y, 0))).toEqual({ kind: 'into', docId: 'p', index: 4 })
  })

  it('hit-tests the cards below where they are drawn, a row lower', () => {
    expect(hit(q.gridX - 1, rowMid(q.y + ROW_PITCH, 0))).toEqual({
      kind: 'into',
      docId: 'q',
      index: 0
    })
  })

  it('in a gap the growth opened, resolves to the undrawn target instead of flashing "between"', () => {
    // The gap just below the grown p, and the one between the pushed-down q and r. "Between" there
    // undid the growth, so the next dragover found the point inside q's (or r's) undrawn card.
    for (const y of [q.y + ROW_PITCH - DOC_GAP_Y / 2, r.y + ROW_PITCH - DOC_GAP_Y / 2]) {
      const t = hit(100, y)
      expect(t).toEqual(computeDropTarget(grown, 100, y, 1, null, true))
      expect(t.kind).toBe('into')
      // …and that is a fixed point.
      expect(
        computeDropTarget(grown, 100, y, 1, null, true, { target: t, ghostWidth: 362 })
      ).toEqual(t)
    }
    // Below every card, "between" after the last stays.
    expect(hit(100, grown.contentHeight + ROW_PITCH)).toEqual({ kind: 'between', docIndex: 3 })
  })

  it('moves a ghost to the end only if the ghost drawn there would open the row too', () => {
    // An external drop borrows the width of the page at its index: landscape at index 1 of
    // P L L L L L P L P wraps it onto a 4th row; at the end it would be portrait and fit row 3.
    const ext = computeLayout(
      [
        {
          id: 'd0',
          name: 'd0.pdf',
          pages: [...'PLLLLLPLP'].map((c, i) => page(`d0-${i}`, c === 'L' ? LANDSCAPE : undefined))
        },
        doc('d1', 4)
      ],
      undefined,
      WRAP_5
    )
    const d0 = ext.items[0]
    const widthAt = (i: number): number => d0.pages[Math.min(i, d0.pages.length - 1)].w
    const drawn: DropView = {
      target: { kind: 'into', docId: 'd0', index: 1 },
      ghostWidth: widthAt(1),
      ghostWidthAt: widthAt
    }
    const y = d0.y + d0.height + 150
    // Retargeting to the end (index 9) expected a grown row there; there is none, so the next
    // dragover fell into d1. Now the drawn target holds…
    expect(computeDropTarget(ext, 100, y, 1, null, true, drawn)).toEqual(drawn.target)
    // …whereas assuming the drawn width everywhere would still move it.
    const { ghostWidthAt: _, ...flat } = drawn
    expect(computeDropTarget(ext, 100, y, 1, null, true, flat)).toEqual({
      kind: 'into',
      docId: 'd0',
      index: 9
    })
  })

  it('a ghost that opens no row leaves the geometry alone', () => {
    const qView: DropView = { target: { kind: 'into', docId: 'q', index: 0 }, ghostWidth: 216 }
    const y = rowMid(p.y, 1)
    expect(computeDropTarget(grown, 100, y, 1, null, true, qView)).toEqual(
      computeDropTarget(grown, 100, y, 1, null, true)
    )
  })

  it('settles: fed back its own result as the drawn view, every point is a fixed point', () => {
    const land = { id: 'l', name: 'l.pdf', pages: [page('l0', LANDSCAPE), page('l1')] }
    const cases = [
      // An external landscape page (no page excluded).
      { layout: grown, exclude: null as string | null, ghostWidth: LANDSCAPE_W },
      // A landscape page dragged out of its own document, over a full portrait one.
      {
        layout: computeLayout([doc('p', 5), land, doc('r', 10)], undefined, WRAP_5),
        exclude: 'l0',
        ghostWidth: LANDSCAPE_W
      }
    ]
    for (const { layout: l, exclude, ghostWidth } of cases) {
      const bottom = l.contentHeight + 2 * ROW_PITCH
      for (let y = -20; y < bottom; y += 7) {
        // From no preview, and from a drag already settled on p's grown end (leaving it downward).
        for (const [x, start] of [5, centreX(1), centreX(4), WRAP_5 - 3].flatMap((x) =>
          [null, target].map((s) => [x, s] as const)
        )) {
          let t: DropTarget | null = start
          const seen: string[] = []
          for (let i = 0; i < 6; i++) {
            const next = computeDropTarget(l, x, y, 1, exclude, true, { target: t, ghostWidth })
            seen.push(JSON.stringify(next))
            if (JSON.stringify(next) === JSON.stringify(t)) break
            t = next
          }
          expect(seen.length, `x=${x} y=${y}: ${seen.join(' → ')}`).toBeLessThan(6)
          // A "between" that the next dragover abandons is a one-frame flash of its ghost row.
          const flash = seen.some((t) => t.includes('between') && t !== seen.at(-1))
          expect(flash, `x=${x} y=${y}: ${seen.join(' → ')}`).toBe(false)
        }
      }
    }
  })
})
