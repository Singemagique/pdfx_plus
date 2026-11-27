import { describe, expect, it } from 'vitest'
import {
  ADD_PAGE_EDGE_SIZE,
  ADD_PAGE_MIN_WIDTH,
  ADD_PAGE_WIDTH,
  BASE_PAGE_HEIGHT,
  CARD_PAD_X,
  DOC_GAP_Y,
  MIN_DOC_WIDTH,
  PAGE_GAP,
  PAGES_TOP,
  ROW_GAP,
  SINGLE_ROW_DOC_HEIGHT,
  computeLayout,
  docHeightForRows,
  flowCells,
  reflowDoc,
  wrapWidthForViewport
} from './layout'
import { FIT_MARGIN, TARGET_FIT_SCALE } from './zoom-constants'
import { makePageKey } from '../edit/model'
import {
  LANDSCAPE,
  LETTER,
  WRAP_5,
  doc,
  page,
  wrapForLetterPages
} from './test-utils/layout-fixtures'

const ROW_PITCH = BASE_PAGE_HEIGHT + ROW_GAP
const LETTER_W = 216
const LANDSCAPE_W = 362

describe('layout constants', () => {
  it('MIN_DOC_WIDTH holds exactly three letter pages per row', () => {
    expect(ADD_PAGE_WIDTH).toBe(LETTER_W)
    expect(MIN_DOC_WIDTH).toBe(3 * LETTER_W + 2 * PAGE_GAP + 2 * CARD_PAD_X)
    expect(MIN_DOC_WIDTH).toBe(wrapForLetterPages(3))
  })

  it('a one-row card is PAGES_TOP + one page + bottom padding', () => {
    expect(docHeightForRows(1)).toBe(SINGLE_ROW_DOC_HEIGHT)
    expect(docHeightForRows(3)).toBe(SINGLE_ROW_DOC_HEIGHT + 2 * ROW_PITCH)
  })
})

describe('wrapWidthForViewport', () => {
  it('wraps so a fitted full row lands at TARGET_FIT_SCALE', () => {
    expect(wrapWidthForViewport(2000)).toBe(Math.round((2000 * FIT_MARGIN) / TARGET_FIT_SCALE))
  })

  it('never wraps narrower than MIN_DOC_WIDTH', () => {
    expect(wrapWidthForViewport(400)).toBe(MIN_DOC_WIDTH)
  })
})

describe('flowCells', () => {
  it('wraps greedily and keeps an over-wide cell on its own row', () => {
    expect(flowCells([100, 100, 100], 218)).toEqual([
      { x: 0, row: 0 },
      { x: 118, row: 0 },
      { x: 0, row: 1 }
    ])
    expect(flowCells([500, 100], 218)).toEqual([
      { x: 0, row: 0 },
      { x: 0, row: 1 }
    ])
  })
})

describe('computeLayout wrapping', () => {
  it('wraps 12 letter pages into 5 + 5 + 2 (+ add-page) at a five-page wrap', () => {
    const layout = computeLayout([doc('a', 12)], undefined, WRAP_5)
    const item = layout.items[0]
    expect(item.rows).toBe(3)
    expect(item.pages.map((p) => p.row)).toEqual([0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 2, 2])
    expect(item.addPage).toEqual({
      x: CARD_PAD_X + 2 * (LETTER_W + PAGE_GAP),
      y: PAGES_TOP + 2 * ROW_PITCH,
      w: ADD_PAGE_WIDTH,
      h: BASE_PAGE_HEIGHT,
      edge: false
    })
    expect(item.height).toBe(docHeightForRows(3))
    expect(item.width).toBe(WRAP_5)
  })

  it('puts more pages per row on a wider wrap', () => {
    const wrap = 2000 // inner 1956 → 8 letter pages
    const item = computeLayout([doc('a', 12)], undefined, wrap).items[0]
    expect(item.pages.filter((p) => p.row === 0)).toHaveLength(8)
    expect(item.rows).toBe(2)
    expect(item.width).toBe(8 * LETTER_W + 7 * PAGE_GAP + 2 * CARD_PAD_X)
  })

  it('never opens a row for the add-page slot when the pages exactly fill the rows', () => {
    for (const [count, rows] of [
      [5, 1],
      [10, 2]
    ]) {
      const item = computeLayout([doc('a', count)], undefined, WRAP_5).items[0]
      expect(item.rows).toBe(rows)
      expect(item.height).toBe(docHeightForRows(rows))
      // A round button straddling the card's right edge, centred on the last row.
      expect(item.addPage).toEqual({
        x: item.width - ADD_PAGE_EDGE_SIZE / 2,
        y: PAGES_TOP + (rows - 1) * ROW_PITCH + (BASE_PAGE_HEIGHT - ADD_PAGE_EDGE_SIZE) / 2,
        w: ADD_PAGE_EDGE_SIZE,
        h: ADD_PAGE_EDGE_SIZE,
        edge: true
      })
    }
  })

  it('a full last row reserves no width, so adding or removing a page keeps contentWidth', () => {
    const widths = [4, 5, 9, 10, 11].map(
      (n) => computeLayout([doc('a', n)], undefined, WRAP_5).contentWidth
    )
    expect(new Set(widths)).toEqual(new Set([WRAP_5]))
    // Three landscape pages leave 30 px of a five-letter wrap: too little for an add-page cell.
    const land = computeLayout([doc('l', 3, LANDSCAPE)], undefined, WRAP_5)
    expect(land.contentWidth).toBe(3 * LANDSCAPE_W + 2 * PAGE_GAP + 2 * CARD_PAD_X)
    expect(land.items[0].addPage.edge).toBe(true)
  })

  it('narrows the add-page cell beside centred pages rather than wrapping it', () => {
    // Four pages + a full add cell fill a five-page card; centring the four leaves the cell 99 px.
    const item = computeLayout([doc('n', 4)], undefined, WRAP_5).items[0]
    expect(item.width).toBe(WRAP_5)
    expect(item.rows).toBe(1)
    const offset = Math.floor((LETTER_W + PAGE_GAP) / 2)
    expect(item.gridX).toBe(CARD_PAD_X + offset)
    expect(item.addPage).toEqual({
      x: item.gridX + 4 * (LETTER_W + PAGE_GAP),
      y: PAGES_TOP,
      w: LETTER_W - offset,
      h: BASE_PAGE_HEIGHT,
      edge: false
    })
    expect(item.addPage.w).toBeGreaterThanOrEqual(ADD_PAGE_MIN_WIDTH)
    expect(item.addPage.x + item.addPage.w).toBe(item.width - CARD_PAD_X)
  })

  it('clamps a wrap narrower than MIN_DOC_WIDTH', () => {
    const layout = computeLayout([doc('a', 12)], undefined, 300)
    expect(layout.wrapWidth).toBe(MIN_DOC_WIDTH)
    // 12 pages, three per row; the add-page slot rides on the full last row.
    expect(layout.items[0].pages.filter((p) => p.row === 0)).toHaveLength(3)
    expect(layout.items[0].rows).toBe(4)
  })

  it('gives a page wider than the wrap a row to itself', () => {
    const wide = { width: 6000, height: 100 }
    const d = { id: 'w', name: 'w.pdf', pages: [page('n0'), page('wide', wide), page('n1')] }
    const item = computeLayout([d], undefined, WRAP_5).items[0]
    expect(item.pages.map((p) => [p.row, p.x])).toEqual([
      [0, CARD_PAD_X],
      [1, CARD_PAD_X],
      [2, CARD_PAD_X]
    ])
    expect(item.pages[1].w).toBeGreaterThan(MIN_DOC_WIDTH)
    expect(item.width).toBe(item.pages[1].w + 2 * CARD_PAD_X)
  })

  it('uses rotated widths for 90°/270° pages', () => {
    const d = {
      id: 'r',
      name: 'r.pdf',
      pages: [page('l0', LANDSCAPE, 0), page('l1', LANDSCAPE, 1)]
    }
    const rotations = new Map([[makePageKey(d.pages[0].source.id, 0), 90]])
    const item = computeLayout([d], rotations, WRAP_5).items[0]
    expect(item.pages[0].w).toBe(LETTER_W)
    expect(item.pages[1].w).toBe(LANDSCAPE_W)
    expect(item.pages[0].x).toBe(item.gridX)
    expect(item.pages[1].x).toBe(item.gridX + LETTER_W + PAGE_GAP)
  })

  it('stacks cards by their real heights', () => {
    const layout = computeLayout([doc('a', 12), doc('b', 1), doc('c', 3)], undefined, WRAP_5)
    const [a, b, c] = layout.items
    expect(a.y).toBe(0)
    expect(b.y).toBe(a.height + DOC_GAP_Y)
    expect(c.y).toBe(b.y + b.height + DOC_GAP_Y)
    expect(b.height).toBe(SINGLE_ROW_DOC_HEIGHT)
    expect(layout.contentHeight).toBe(c.y + c.height + DOC_GAP_Y + SINGLE_ROW_DOC_HEIGHT)
  })

  it('places page cells in world coordinates (card offset included)', () => {
    const layout = computeLayout([doc('a', 1), doc('b', 7)], undefined, WRAP_5)
    const b = layout.items[1]
    expect(b.pages[6]).toEqual({
      pageId: 'b-p6',
      x: CARD_PAD_X + LETTER_W + PAGE_GAP,
      y: b.y + PAGES_TOP + ROW_PITCH,
      w: LETTER_W,
      h: BASE_PAGE_HEIGHT,
      row: 1
    })
  })

  it('contentWidth is the widest card, never below MIN_DOC_WIDTH', () => {
    expect(computeLayout([doc('a', 2)], undefined, 3000).contentWidth).toBe(MIN_DOC_WIDTH)
    const wide = computeLayout([doc('a', 2), doc('b', 30)], undefined, 3000)
    expect(wide.contentWidth).toBe(wide.items[1].width)
    expect(wide.contentWidth).toBeLessThanOrEqual(3000)
    // Every card spans the collection's width, so the right edges line up.
    expect(wide.items[0].width).toBe(wide.contentWidth)
  })

  it('centres a narrower document’s pages in the shared card width', () => {
    const layout = computeLayout([doc('n', 2), doc('w', 12)], undefined, WRAP_5)
    const [n, w] = layout.items
    expect(n.width).toBe(w.width)
    const left = n.pages[0].x - n.x
    const right = n.x + n.width - (n.pages[1].x + n.pages[1].w)
    expect(Math.abs(left - right)).toBeLessThanOrEqual(1)
    expect(n.gridX).toBe(n.pages[0].x)
    // The add-page cell still follows the last page, inside the card.
    expect(n.addPage.x).toBe(n.pages[1].x + LETTER_W + PAGE_GAP)
    expect(n.addPage.w).toBe(ADD_PAGE_WIDTH)
    // The widest card has no slack, so its grid starts at the padding as before.
    expect(w.gridX).toBe(CARD_PAD_X)
  })

  it('centres every card fully, even one with too little slack for an add-page cell', () => {
    // A single 728 px page sets a 772 px card width at the narrowest wrap. Beside it, a landscape +
    // letter card has 132 px of slack: centring used to stop 22 px short so a 48 px add cell still
    // fitted after the letter page, which left it visibly off-centre beside its centred neighbours.
    const wide = { id: 'w', name: 'w.pdf', pages: [page('w0', { width: 728, height: 280 })] }
    const land = { id: 'l', name: 'l.pdf', pages: [page('l0', LANDSCAPE), page('l1')] }
    const layout = computeLayout([wide, land, doc('p', 2), doc('t', 3)], undefined, MIN_DOC_WIDTH)
    expect(layout.contentWidth).toBe(728 + 2 * CARD_PAD_X)
    for (const item of layout.items) {
      const end = Math.max(...item.pages.map((p) => p.x + p.w))
      const left = item.pages[0].x - item.x
      const right = item.x + item.width - end
      expect(Math.abs(left - right), item.doc.id).toBeLessThanOrEqual(1)
      // The add-page slot stays a usable cell inside the card, or becomes the edge button.
      const a = item.addPage
      if (a.edge) expect(a.x, item.doc.id).toBe(item.width - ADD_PAGE_EDGE_SIZE / 2)
      else {
        expect(a.w, item.doc.id).toBeGreaterThanOrEqual(ADD_PAGE_MIN_WIDTH)
        expect(a.x + a.w, item.doc.id).toBeLessThanOrEqual(item.width - CARD_PAD_X)
      }
    }
    const [w, l, p, t] = layout.items
    expect(w.addPage.edge).toBe(true)
    // 66 px each side leaves exactly a minimum cell after the letter page.
    expect(l.gridX).toBe(CARD_PAD_X + 66)
    expect(l.addPage).toMatchObject({ w: ADD_PAGE_MIN_WIDTH, edge: false })
    expect(p.addPage).toMatchObject({ w: 121, edge: false })
    // 22 px each side is too little for a cell after the gap: the edge button, grid still centred.
    expect(t.gridX).toBe(CARD_PAD_X + 22)
    expect(t.addPage.edge).toBe(true)
  })

  it('centres each card on its widest row; shorter rows below stay left-aligned under it', () => {
    // At a 2000 px wrap: 8 letter pages per row (1854 px) beside 5 landscape ones (1882 px).
    const layout = computeLayout([doc('s', 10), doc('x', 5, LANDSCAPE)], undefined, 2000)
    const s = layout.items[0]
    expect(s.gridX).toBe(CARD_PAD_X + 14)
    const rowOf = (r: number): typeof s.pages => s.pages.filter((p) => p.row === r)
    expect(rowOf(1)[0].x).toBe(rowOf(0)[0].x)
    const last = rowOf(0).at(-1)!
    const left = rowOf(0)[0].x - s.x
    const right = s.x + s.width - (last.x + last.w)
    expect(Math.abs(left - right)).toBeLessThanOrEqual(1)
  })

  it('an empty collection has a 1×1 placeholder extent', () => {
    expect(computeLayout([])).toMatchObject({ items: [], contentWidth: 1, contentHeight: 1 })
  })
})

describe('reflowDoc (mid-drag view)', () => {
  const item = computeLayout([doc('a', 6)], undefined, WRAP_5).items[0]

  it('closes up around the excluded page', () => {
    const r = reflowDoc(item, 'a-p1', null)
    expect(r.pages.map((p) => p.pageId)).toEqual(['a-p0', 'a-p2', 'a-p3', 'a-p4', 'a-p5'])
    expect(r.pages.every((p) => p.row === 0)).toBe(true)
    expect(r.ghost).toBeNull()
    expect(r.height).toBe(SINGLE_ROW_DOC_HEIGHT)
  })

  it('opens the ghost at the visible index and wraps what follows', () => {
    const r = reflowDoc(item, null, { index: 2, w: LETTER_W })
    expect(r.ghost).toEqual({
      x: CARD_PAD_X + 2 * (LETTER_W + PAGE_GAP),
      y: PAGES_TOP,
      w: LETTER_W,
      h: BASE_PAGE_HEIGHT
    })
    expect(r.pages.find((p) => p.pageId === 'a-p4')?.row).toBe(1)
    expect(r.height).toBe(docHeightForRows(2))
  })

  it('clamps a ghost index past the end', () => {
    const r = reflowDoc(item, null, { index: 99, w: LETTER_W })
    expect(r.ghost?.x).toBe(CARD_PAD_X + LETTER_W + PAGE_GAP)
    expect(r.ghost?.y).toBe(PAGES_TOP + ROW_PITCH)
  })

  it('without exclusion or ghost matches the layout cells', () => {
    const r = reflowDoc(item, null, null)
    expect(r.pages).toEqual(item.pages)
  })

  it('keeps a centred grid in place while a drag opens and closes gaps', () => {
    const [n] = computeLayout([doc('n', 2), doc('w', 12)], undefined, WRAP_5).items
    const collapsed = reflowDoc(n, 'n-p0', null)
    expect(collapsed.pages[0].x).toBe(n.gridX)
    const opened = reflowDoc(n, null, { index: 0, w: LETTER_W })
    expect(opened.ghost?.x).toBe(n.gridX)
    expect(opened.pages[0].x).toBe(n.gridX + LETTER_W + PAGE_GAP)
  })

  it('moves a centred grid left only as far as a widened row needs to stay in the card', () => {
    // Three landscape pages set the card width; two letter pages are centred in it.
    const layout = computeLayout([doc('l', 3, LANDSCAPE), doc('n', 2)], undefined, WRAP_5)
    const n = layout.items[1]
    const r = reflowDoc(n, null, { index: 2, w: LANDSCAPE_W })
    const right = r.ghost!.x + r.ghost!.w
    expect(right).toBe(n.x + n.width - CARD_PAD_X)
    expect(r.pages[0].x).toBeLessThan(n.gridX)
    expect(r.height).toBe(SINGLE_ROW_DOC_HEIGHT)
  })

  it('uses the letter fixture as 216 px', () => {
    expect(computeLayout([doc('x', 1, LETTER)]).items[0].pages[0].w).toBe(LETTER_W)
  })
})
