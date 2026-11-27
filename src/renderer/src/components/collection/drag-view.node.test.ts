import { describe, expect, it } from 'vitest'
import { computeDragView, type DragViewInput } from './drag-view'
import { deriveDropGhosts, deriveDropView } from './ghost-size'
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

  it('a cropped page in a centred card: drawn and hit where its cropped cell sits, and wrapping a full row holds', () => {
    // c holds a landscape-ish crop (612×400 → 428 wide) and a letter page, centred in the shared
    // width the full five-page p sets. Dragging the cropped page to the end of p wraps it onto a new
    // row; the hit test must use the same cropped widths and centred grid the drag view draws.
    const c = { id: 'c', name: 'c.pdf', pages: [page('c0'), page('c1')] }
    const crop = { x: 0, y: 200, w: 612, h: 400 }
    const crops = new Map([[makePageKey(c.pages[0].source.id, 0), crop]])
    const layout = computeLayout([doc('p', 5), c, doc('q', 2)], { crops }, WRAP_5)
    const [p, ci, q] = layout.items
    const cropW = Math.round((280 * 612) / 400)
    expect(ci.pages[0].w).toBe(cropW)
    expect(ci.width).toBe(p.width)
    // Centred: equal slack either side of the cropped row.
    const end = ci.pages[1].x + ci.pages[1].w
    expect(Math.abs(ci.pages[0].x - ci.x - (ci.x + ci.width - end))).toBeLessThanOrEqual(1)
    expect(ci.gridX).toBeGreaterThan(22)

    // Not dragging yet: inside c, the cropped cell's midpoint splits index 0 from 1.
    const mid = ci.pages[0].x + cropW / 2
    const rowY = ci.pages[0].y + ci.pages[0].h / 2
    const hit = (x: number, y: number, ex: string | null, v: DropView | null): DropTarget =>
      computeDropTarget(layout, x, y, 1, ex, true, v)
    expect(hit(mid - 5, rowY, null, null)).toEqual({ kind: 'into', docId: 'c', index: 0 })
    expect(hit(mid + 5, rowY, null, null)).toEqual({ kind: 'into', docId: 'c', index: 1 })

    const dragging = { docId: 'c', pageId: 'c0' }
    const target: DropTarget = { kind: 'into', docId: 'p', index: 5 }
    const ghosts = deriveDropGhosts(layout, dragging, target, 'internal', 0)
    expect(ghosts.ghostSize).toEqual({ width: cropW, height: 280 })
    const v = computeDragView(layout, {
      collapsedId: 'c0',
      draggingDocId: 'c',
      intoDocId: ghosts.intoDocId,
      intoIndex: ghosts.intoIndex,
      intoGhostWidth: ghosts.ghostSize.width,
      intoGhostHeight: ghosts.ghostSize.height,
      betweenIndex: ghosts.betweenIndex
    })
    const ghost = v.reflows.get('p')!.ghost!
    expect(ghost.w).toBe(cropW)
    expect(ghost.y).toBeGreaterThan(p.y + p.height)
    const grew = docHeightForRows(2) - docHeightForRows(1)
    expect(v.shifts).toEqual([0, grew, grew])

    const drawn = deriveDropView(layout, dragging, target, 'internal')
    expect(drawn.ghostWidth).toBe(cropW)
    for (const fx of [0.05, 0.5, 0.95]) {
      expect(hit(ghost.x + ghost.w * fx, ghost.y + ghost.h / 2, 'c0', drawn)).toEqual(target)
    }
    // c (closed up around the dragged crop, still centred where it was) and q are hit where the
    // drag view draws them, shifted down by the grown row.
    const cDrawn = v.reflows.get('c')!.pages[0]
    expect(cDrawn.pageId).toBe('c1')
    expect(cDrawn.x).toBe(ci.gridX)
    const cy = cDrawn.y + grew + cDrawn.h / 2
    expect(hit(cDrawn.x + 2, cy, 'c0', drawn)).toEqual({ kind: 'into', docId: 'c', index: 0 })
    expect(hit(cDrawn.x + cDrawn.w - 2, cy, 'c0', drawn)).toEqual({
      kind: 'into',
      docId: 'c',
      index: 1
    })
    expect(hit(q.gridX + 1, q.y + grew + q.height / 2, 'c0', drawn)).toMatchObject({
      kind: 'into',
      docId: 'q'
    })
  })

  it('an external drop on a grown row settles inside the card it sees drawn', () => {
    // An external ghost borrows the width of the page at its index: landscape mid-document, portrait
    // at the end. Drawn at a landscape page, it wraps d0 onto a 4th row; the hit test used to move
    // it to the end on that row, where a portrait ghost fits row 3, so d0 shrank back and the next
    // dragover landed in d1 — the flicker the extended geometry was meant to remove.
    const d0 = {
      id: 'd0',
      name: 'd0.pdf',
      pages: [...'PLLLLLPLP'].map((c, i) => page(`d0-${i}`, c === 'L' ? LANDSCAPE : undefined))
    }
    const mixed = computeLayout([d0, doc('d1', 4)], undefined, WRAP_5)
    const [a] = mixed.items
    const x = 100
    const y = a.y + a.height + 150
    for (let start = 0; start <= a.pages.length; start++) {
      let t: DropTarget = { kind: 'into', docId: 'd0', index: start }
      const view = (): DropView => deriveDropView(mixed, null, t, 'external')
      const g = deriveDropGhosts(mixed, null, t, 'external', 1)
      const drawn = computeDragView(mixed, {
        ...idle,
        intoDocId: g.intoDocId,
        intoIndex: g.intoIndex,
        intoGhostWidth: g.ghostSize.width
      })
      // Only starts whose drawn ghost reaches down under the pointer.
      if (a.y + (drawn.reflows.get('d0')?.height ?? 0) < y) continue
      const seen: string[] = []
      for (let i = 0; i < 4; i++) {
        const next = computeDropTarget(mixed, x, y, 1, null, true, view())
        seen.push(JSON.stringify(next))
        if (JSON.stringify(next) === JSON.stringify(t)) break
        t = next as typeof t
      }
      expect(seen, `start ${start}`).toHaveLength(1)
      expect(t, `start ${start}`).toMatchObject({ kind: 'into', docId: 'd0' })
    }
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
    const layout = computeLayout([d], { rotations })
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

  it('a dragged cropped page keeps its cropped slot size, and its reflow ghost is centred', () => {
    const d = { id: 'c', name: 'c.pdf', pages: [page('c0'), page('c1')] }
    const line = { x: 0, y: 300, w: 612, h: 20 }
    const crops = new Map([[makePageKey(d.pages[0].source.id, 0), line]])
    const layout = computeLayout([d], { crops }, 3000)
    const slot = layout.items[0].pages[0]
    const g = deriveDropGhosts(
      layout,
      { docId: 'c', pageId: 'c0' },
      { kind: 'into', docId: 'c', index: 1 },
      'internal',
      0
    )
    expect(g.ghostSize).toEqual({ width: slot.w, height: slot.h })
    expect(slot.h).toBeLessThan(280)
    const v = computeDragView(layout, {
      ...idle,
      collapsedId: 'c0',
      draggingDocId: 'c',
      intoDocId: 'c',
      intoIndex: 1,
      intoGhostWidth: g.ghostSize.width,
      intoGhostHeight: g.ghostSize.height
    })
    const ghost = v.reflows.get('c')!.ghost!
    expect(ghost.h).toBe(slot.h)
    expect(ghost.y).toBe(slot.y)
  })

  it('an external drop borrows the size of the target page at the index', () => {
    const layout = computeLayout([{ id: 'l', name: 'l.pdf', pages: [page('x', LANDSCAPE)] }])
    const g = deriveDropGhosts(layout, null, { kind: 'into', docId: 'l', index: 0 }, 'external', 1)
    expect(g.ghostSize.width).toBe(362)
  })
})
