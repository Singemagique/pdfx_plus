import { describe, expect, it } from 'vitest'
import {
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
import { LANDSCAPE, LETTER, doc, page } from './test-utils/layout-fixtures'

const ROW_PITCH = BASE_PAGE_HEIGHT + ROW_GAP
const LETTER_W = 216
const LANDSCAPE_W = 362

describe('layout constants', () => {
  it('MIN_DOC_WIDTH holds exactly five letter pages per row', () => {
    expect(ADD_PAGE_WIDTH).toBe(LETTER_W)
    expect(MIN_DOC_WIDTH).toBe(5 * LETTER_W + 4 * PAGE_GAP + 2 * CARD_PAD_X)
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
  it('wraps 12 letter pages into 5 + 5 + 2 (+ add-page) at the minimum width', () => {
    const layout = computeLayout([doc('a', 12)], undefined, MIN_DOC_WIDTH)
    const item = layout.items[0]
    expect(item.rows).toBe(3)
    expect(item.pages.map((p) => p.row)).toEqual([0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 2, 2])
    expect(item.addPage).toEqual({
      x: CARD_PAD_X + 2 * (LETTER_W + PAGE_GAP),
      y: PAGES_TOP + 2 * ROW_PITCH,
      w: ADD_PAGE_WIDTH,
      h: BASE_PAGE_HEIGHT
    })
    expect(item.height).toBe(docHeightForRows(3))
    expect(item.width).toBe(MIN_DOC_WIDTH)
  })

  it('puts more pages per row on a wider wrap', () => {
    const wrap = 2000 // inner 1956 → 8 letter pages
    const item = computeLayout([doc('a', 12)], undefined, wrap).items[0]
    expect(item.pages.filter((p) => p.row === 0)).toHaveLength(8)
    expect(item.rows).toBe(2)
    expect(item.width).toBe(8 * LETTER_W + 7 * PAGE_GAP + 2 * CARD_PAD_X)
  })

  it('puts the add-page slot on a row of its own when the pages exactly fill the rows', () => {
    const item = computeLayout([doc('a', 5)], undefined, MIN_DOC_WIDTH).items[0]
    expect(item.pages.every((p) => p.row === 0)).toBe(true)
    expect(item.rows).toBe(2)
    expect(item.addPage.x).toBe(CARD_PAD_X)
  })

  it('clamps a wrap narrower than MIN_DOC_WIDTH', () => {
    const layout = computeLayout([doc('a', 12)], undefined, 300)
    expect(layout.wrapWidth).toBe(MIN_DOC_WIDTH)
    expect(layout.items[0].rows).toBe(3)
  })

  it('gives a page wider than the wrap a row to itself', () => {
    const wide = { width: 6000, height: 100 }
    const d = { id: 'w', name: 'w.pdf', pages: [page('n0'), page('wide', wide), page('n1')] }
    const item = computeLayout([d], undefined, MIN_DOC_WIDTH).items[0]
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
    const item = computeLayout([d], rotations, MIN_DOC_WIDTH).items[0]
    expect(item.pages[0].w).toBe(LETTER_W)
    expect(item.pages[1].w).toBe(LANDSCAPE_W)
    expect(item.pages[1].x).toBe(CARD_PAD_X + LETTER_W + PAGE_GAP)
  })

  it('stacks cards by their real heights', () => {
    const layout = computeLayout([doc('a', 12), doc('b', 1), doc('c', 3)], undefined, MIN_DOC_WIDTH)
    const [a, b, c] = layout.items
    expect(a.y).toBe(0)
    expect(b.y).toBe(a.height + DOC_GAP_Y)
    expect(c.y).toBe(b.y + b.height + DOC_GAP_Y)
    expect(b.height).toBe(SINGLE_ROW_DOC_HEIGHT)
    expect(layout.contentHeight).toBe(c.y + c.height + DOC_GAP_Y + SINGLE_ROW_DOC_HEIGHT)
  })

  it('places page cells in world coordinates (card offset included)', () => {
    const layout = computeLayout([doc('a', 1), doc('b', 7)], undefined, MIN_DOC_WIDTH)
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
  })

  it('an empty collection has a 1×1 placeholder extent', () => {
    expect(computeLayout([])).toMatchObject({ items: [], contentWidth: 1, contentHeight: 1 })
  })
})

describe('reflowDoc (mid-drag view)', () => {
  const item = computeLayout([doc('a', 6)], undefined, MIN_DOC_WIDTH).items[0]

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

  it('uses the letter fixture as 216 px', () => {
    expect(computeLayout([doc('x', 1, LETTER)]).items[0].pages[0].w).toBe(LETTER_W)
  })
})
