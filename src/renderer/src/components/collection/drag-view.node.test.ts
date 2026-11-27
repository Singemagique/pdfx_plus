import { describe, expect, it } from 'vitest'
import { computeDragView, type DragViewInput } from './drag-view'
import { deriveDropGhosts } from './ghost-size'
import { BETWEEN_GHOST_SHIFT, computeLayout, docHeightForRows } from '../../canvas/layout'
import { makePageKey } from '../../edit/model'
import { LANDSCAPE, WRAP_5, doc, page } from '../../canvas/test-utils/layout-fixtures'

const idle: DragViewInput = {
  collapsedId: null,
  draggingDocId: null,
  intoDocId: null,
  intoIndex: -1,
  intoGhostWidth: 216,
  betweenIndex: -1
}

describe('computeDragView', () => {
  const layout = computeLayout([doc('a', 3), doc('b', 9), doc('c', 1)], undefined, WRAP_5)

  it('leaves everything in place with no drag', () => {
    expect(computeDragView(layout, idle)).toEqual({ reflows: new Map(), shifts: [0, 0, 0] })
  })

  it('slides the cards below the between ghost down by one ghost row', () => {
    expect(computeDragView(layout, { ...idle, betweenIndex: 1 }).shifts).toEqual([
      0,
      BETWEEN_GHOST_SHIFT,
      BETWEEN_GHOST_SHIFT
    ])
  })

  it('pushes later cards down when the into-ghost adds a row to its target', () => {
    // b: 9 pages wrap 5 + 4 (+ add-page) = 2 rows; with a ghost the 10 pages still fill 2 rows…
    const same = computeDragView(layout, { ...idle, intoDocId: 'b', intoIndex: 0 })
    expect(same.reflows.get('b')?.height).toBe(docHeightForRows(2))
    expect(same.shifts).toEqual([0, 0, 0])
    // …while a: 3 pages + add-page fit one row, and so do 4 pages; c's card is unaffected.
    const wide = computeDragView(layout, {
      ...idle,
      intoDocId: 'a',
      intoIndex: 1,
      intoGhostWidth: 800
    })
    expect(wide.reflows.get('a')?.height).toBe(docHeightForRows(2))
    const grew = docHeightForRows(2) - docHeightForRows(1)
    expect(wide.shifts).toEqual([0, grew, grew])
  })

  it('collapses the dragged page out of its own document only', () => {
    const v = computeDragView(layout, { ...idle, collapsedId: 'b-p0', draggingDocId: 'b' })
    expect([...v.reflows.keys()]).toEqual(['b'])
    expect(v.reflows.get('b')?.pages.map((p) => p.pageId)).not.toContain('b-p0')
  })
})

describe('deriveDropGhosts sizes ghosts from the layout', () => {
  it('a dragged rotated page keeps its rotated width', () => {
    const d = { id: 'r', name: 'r.pdf', pages: [page('l0', LANDSCAPE, 0), page('p1')] }
    const rotations = new Map([[makePageKey(d.pages[0].source.id, 0), 90]])
    const layout = computeLayout([d], rotations)
    const g = deriveDropGhosts(
      layout,
      { docId: 'r', pageId: 'l0' },
      { kind: 'into', docId: 'r', index: 1 },
      'internal',
      0
    )
    expect(g.ghostSize).toEqual({ width: 216, height: 280 })
    expect(g.betweenPages).toEqual([{ width: 216, height: 280 }])
  })

  it('an external drop borrows the size of the target page at the index', () => {
    const layout = computeLayout([{ id: 'l', name: 'l.pdf', pages: [page('x', LANDSCAPE)] }])
    const g = deriveDropGhosts(layout, null, { kind: 'into', docId: 'l', index: 0 }, 'external', 1)
    expect(g.ghostSize.width).toBe(362)
  })
})
