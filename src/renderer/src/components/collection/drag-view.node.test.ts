import { describe, expect, it } from 'vitest'
import { computeDragView, type DragViewInput } from './drag-view'
import { deriveDropGhosts } from './ghost-size'
import {
  BETWEEN_GHOST_SHIFT,
  computeDropTarget,
  computeLayout,
  docHeightForRows
} from '../../canvas/layout'
import type { DropTarget, DropView } from '../../canvas/layout'
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

  it('a full row gets no add-page row, so a ghost at its end opens one and pushes cards down', () => {
    const full = computeLayout([doc('p', 5), doc('q', 1)], undefined, WRAP_5)
    expect(full.items[0].height).toBe(docHeightForRows(1))
    const v = computeDragView(full, { ...idle, intoDocId: 'p', intoIndex: 5, intoGhostWidth: 362 })
    expect(v.reflows.get('p')?.height).toBe(docHeightForRows(2))
    expect(v.shifts).toEqual([0, docHeightForRows(2) - docHeightForRows(1)])
  })

  it('the drop hit test agrees with what it draws: on the ghost’s new row, the target holds', () => {
    // A landscape page dragged out of l and into the end of p, whose portrait row is full.
    const land = { id: 'l', name: 'l.pdf', pages: [page('l0', LANDSCAPE), page('l1')] }
    const full = computeLayout([doc('p', 5), land, doc('q', 3)], undefined, WRAP_5)
    const dragging = { docId: 'l', pageId: 'l0' }
    const target: DropTarget = { kind: 'into', docId: 'p', index: 5 }
    const ghosts = deriveDropGhosts(full, dragging, target, 'internal', 0)
    const v = computeDragView(full, {
      collapsedId: 'l0',
      draggingDocId: 'l',
      intoDocId: ghosts.intoDocId,
      intoIndex: ghosts.intoIndex,
      intoGhostWidth: ghosts.ghostSize.width,
      betweenIndex: ghosts.betweenIndex
    })
    const ghost = v.reflows.get('p')?.ghost
    expect(ghost?.y).toBeGreaterThan(full.items[0].y + full.items[0].height)
    const drawn: DropView = { target, ghostWidth: ghosts.ghostSize.width }
    const at = (x: number, y: number): DropTarget =>
      computeDropTarget(full, x, y, 1, 'l0', true, drawn)
    // Anywhere on the ghost, and on the rest of its row, keeps dropping into p at the end.
    for (const fx of [0.1, 0.5, 0.9]) {
      for (const fy of [0.1, 0.5, 0.9]) {
        expect(at(ghost!.x + ghost!.w * fx, ghost!.y + ghost!.h * fy)).toEqual(target)
      }
    }
    expect(at(full.items[0].width - 30, ghost!.y + ghost!.h / 2)).toEqual(target)
    // Each later card is hit where it is drawn: its layout y plus its drag shift.
    full.items.slice(1).forEach((item, i) => {
      const y = item.y + v.shifts[i + 1] + item.height / 2
      expect(at(item.gridX + 1, y)).toMatchObject({ kind: 'into', docId: item.doc.id })
    })
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
