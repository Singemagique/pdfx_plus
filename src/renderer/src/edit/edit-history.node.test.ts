import { describe, expect, it } from 'vitest'

import { apply, canRedo, canUndo, initHistory, redo, undo } from './history'
import {
  emptyEditState,
  loadIntoHistory,
  rotateInHistory,
  setCropInHistory,
  type EditState
} from './edit-history'
import type { CropBox, Overlay } from './model'

const start = () => initHistory<EditState>(emptyEditState())

const highlight = (id: string, pageKey = 'p'): Overlay => ({
  id,
  pageKey,
  z: 0,
  createdAt: 0,
  geom: { x: 0, y: 0, w: 10, h: 10, rotation: 0, opacity: 0.4 },
  type: 'highlight',
  color: { r: 1, g: 1, b: 0 }
})
const box = (x: number): CropBox => ({ x, y: 0, w: 50, h: 60 })

describe('rotateInHistory (P2-7 undoable rotation)', () => {
  it('records rotation as an undoable step', () => {
    let h = rotateInHistory(start(), 'p1', 90)
    expect(h.present.rotations).toEqual({ p1: 90 })
    expect(canUndo(h)).toBe(true)
    h = undo(h)
    expect(h.present.rotations).toEqual({}) // rotation is gone
    expect(redo(h).present.rotations).toEqual({ p1: 90 })
  })

  it('accumulates deltas and drops the key at a net-zero rotation', () => {
    let h = rotateInHistory(start(), 'p1', 90)
    h = rotateInHistory(h, 'p1', 90) // 180
    expect(h.present.rotations).toEqual({ p1: 180 })
    h = rotateInHistory(h, 'p1', -180) // back to 0 → key removed
    expect(h.present.rotations).toEqual({})
    // Undo the net-zero step re-adds 180 (the inverse of the delete).
    expect(undo(h).present.rotations).toEqual({ p1: 180 })
  })

  it('normalizes negative rotation into [0,360)', () => {
    expect(rotateInHistory(start(), 'p1', -90).present.rotations).toEqual({ p1: 270 })
  })
})

describe('setCropInHistory (P2-7 undoable crop)', () => {
  it('records a crop and undoes/redoes it', () => {
    let h = setCropInHistory(start(), 'p1', box(5))
    expect(h.present.crops).toEqual({ p1: box(5) })
    h = undo(h)
    expect(h.present.crops).toEqual({})
    expect(redo(h).present.crops).toEqual({ p1: box(5) })
  })

  it('clearing an existing crop is undoable; clearing an absent crop is a no-op', () => {
    const withCrop = setCropInHistory(start(), 'p1', box(5))
    const cleared = setCropInHistory(withCrop, 'p1', null)
    expect(cleared.present.crops).toEqual({})
    expect(undo(cleared).present.crops).toEqual({ p1: box(5) }) // clearing was undoable

    const noop = setCropInHistory(start(), 'p1', null) // nothing to clear
    expect(canUndo(noop)).toBe(false) // no empty undo entry
  })
})

describe('unified undo timeline across overlays + rotate + crop', () => {
  it('undoes interleaved edits in reverse order, each independently', () => {
    let h = start()
    h = apply(h, (d) => void d.overlays.push(highlight('o1'))) // 1: overlay
    h = rotateInHistory(h, 'p1', 90) // 2: rotate
    h = setCropInHistory(h, 'p1', box(5)) // 3: crop
    expect(h.present.overlays).toHaveLength(1)
    expect(h.present.rotations).toEqual({ p1: 90 })
    expect(h.present.crops).toEqual({ p1: box(5) })

    h = undo(h) // undo crop
    expect(h.present.crops).toEqual({})
    expect(h.present.rotations).toEqual({ p1: 90 }) // untouched
    h = undo(h) // undo rotate
    expect(h.present.rotations).toEqual({})
    expect(h.present.overlays).toHaveLength(1) // untouched
    h = undo(h) // undo overlay
    expect(h.present.overlays).toHaveLength(0)
    expect(canUndo(h)).toBe(false)
  })

  it('a rotate edit leaves the overlays reference untouched (structural sharing)', () => {
    const h0 = apply(start(), (d) => void d.overlays.push(highlight('o1')))
    const h1 = rotateInHistory(h0, 'p1', 90)
    expect(h1.present.overlays).toBe(h0.present.overlays) // same ref → memoized layout won't churn
    expect(h1.present.crops).toBe(h0.present.crops)
  })
})

describe('loadIntoHistory (P2-7 checkpoint, not a lossy undo step)', () => {
  it('merges loaded state and makes it non-undoable (Ctrl+Z cannot strip it)', () => {
    const loaded = {
      overlays: [highlight('imported')],
      rotations: [['p1', 90]] as Array<[string, number]>,
      crops: [['p2', box(3)]] as Array<[string, CropBox]>
    }
    const h = loadIntoHistory(start(), loaded)
    expect(h.present.overlays).toHaveLength(1)
    expect(h.present.rotations).toEqual({ p1: 90 })
    expect(h.present.crops).toEqual({ p2: box(3) })
    expect(canUndo(h)).toBe(false) // the load itself is not an undoable step
    expect(canRedo(h)).toBe(false)
  })

  it('folds loaded content onto existing content and resets the undo stack', () => {
    let h = apply(start(), (d) => void d.overlays.push(highlight('existing')))
    h = rotateInHistory(h, 'p0', 180)
    expect(canUndo(h)).toBe(true)
    h = loadIntoHistory(h, {
      overlays: [highlight('imported')],
      rotations: [['p1', 90]],
      crops: []
    })
    expect(h.present.overlays.map((o) => o.id)).toEqual(['existing', 'imported']) // both kept
    expect(h.present.rotations).toEqual({ p0: 180, p1: 90 }) // both kept
    expect(canUndo(h)).toBe(false) // checkpoint: prior stack cleared
  })

  it('a post-load edit is undoable but stops at the loaded baseline', () => {
    let h = loadIntoHistory(start(), {
      overlays: [highlight('imported')],
      rotations: [],
      crops: []
    })
    h = apply(h, (d) => void d.overlays.push(highlight('new')))
    expect(h.present.overlays).toHaveLength(2)
    h = undo(h) // undoes only the new edit
    expect(h.present.overlays.map((o) => o.id)).toEqual(['imported']) // baseline survives
    expect(canUndo(h)).toBe(false)
  })
})
