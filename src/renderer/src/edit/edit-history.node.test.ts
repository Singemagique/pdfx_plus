import { describe, expect, it } from 'vitest'

import { apply, canRedo, canUndo, initHistory, redo, undo } from './history'
import {
  addOverlayInHistory,
  emptyEditState,
  loadIntoHistory,
  removeOverlayInHistory,
  replaceOverlayInHistory,
  rotateInHistory,
  setCropInHistory,
  setFormValueInHistory,
  type EditState
} from './edit-history'
import type { CropBox, Geom, Overlay } from './model'

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
const geom = (x: number): Geom => ({ x, y: 0, w: 100, h: 20, rotation: 0, opacity: 1 })
const formValues = (h: { present: EditState }): Array<[string, string | boolean]> =>
  h.present.overlays
    .filter((o) => o.type === 'formValue')
    .map((o) => [o.field, o.value] as [string, string | boolean])

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

  it('folds loaded content onto existing content and KEEPS prior steps undoable', () => {
    let h = apply(start(), (d) => void d.overlays.push(highlight('existing')))
    h = rotateInHistory(h, 'p0', 180)
    h = loadIntoHistory(h, {
      overlays: [highlight('imported')],
      rotations: [['p1', 90]],
      crops: []
    })
    expect(h.present.overlays.map((o) => o.id)).toEqual(['existing', 'imported']) // both kept
    expect(h.present.rotations).toEqual({ p0: 180, p1: 90 }) // both kept
    expect(canUndo(h)).toBe(true) // pre-import work is NOT thrown away by opening a document
    expect(canRedo(h)).toBe(false) // redo steps were recorded against a present that's gone
  })

  it('is not itself an undo step: undo after a load reverts the PRE-load edit, not the import', () => {
    let h = apply(start(), (d) => void d.overlays.push(highlight('existing')))
    h = rotateInHistory(h, 'p0', 180)
    h = loadIntoHistory(h, {
      overlays: [highlight('imported')],
      rotations: [['p1', 90]],
      crops: []
    })

    h = undo(h) // undoes the rotate, NOT the import
    expect(h.present.rotations).toEqual({ p1: 90 }) // loaded rotation survives; p0 reverted
    expect(h.present.overlays.map((o) => o.id)).toEqual(['existing', 'imported'])

    h = undo(h) // undoes the pre-load overlay, leaving the imported content intact
    expect(h.present.overlays.map((o) => o.id)).toEqual(['imported'])
    expect(canUndo(h)).toBe(false) // and there is no step that would strip the import
  })

  it('undoing a pre-load step does not disturb loaded content at other indices/keys', () => {
    let h = apply(start(), (d) => void d.overlays.push(highlight('existing')))
    h = setCropInHistory(h, 'p0', box(5))
    h = loadIntoHistory(h, {
      overlays: [highlight('i1'), highlight('i2')],
      rotations: [['p9', 270]],
      crops: [['p9', box(7)]]
    })
    h = undo(h) // undo the pre-load crop
    expect(h.present.crops).toEqual({ p9: box(7) }) // the loaded crop is untouched
    expect(h.present.rotations).toEqual({ p9: 270 })
    // Loaded overlays appended at the TAIL, so the pre-load index-addressed patches still line up.
    expect(h.present.overlays.map((o) => o.id)).toEqual(['existing', 'i1', 'i2'])
  })

  it('clears redo, so a stale redo cannot be replayed onto the merged present', () => {
    let h = apply(start(), (d) => void d.overlays.push(highlight('existing')))
    h = undo(h)
    expect(canRedo(h)).toBe(true)
    h = loadIntoHistory(h, { overlays: [highlight('imported')], rotations: [], crops: [] })
    expect(canRedo(h)).toBe(false)
  })

  it('is a coalesce boundary: a post-load edit never folds into a pre-load step', () => {
    // Same page, same field on both sides of the load — the coalesce key is identical, so without
    // closing the top retained step the second burst would merge into the first.
    let h = setFormValueInHistory(start(), 'p1', 'name', 'Ada', geom(0))
    expect(h.past).toHaveLength(1)
    h = loadIntoHistory(h, { overlays: [highlight('imported')], rotations: [], crops: [] })
    h = setFormValueInHistory(h, 'p1', 'name', 'Grace', geom(0))
    expect(h.past).toHaveLength(2) // two steps, not one merged step
    expect(formValues(h)).toEqual([['name', 'Grace']])

    h = undo(h) // reverts only the post-load edit
    expect(formValues(h)).toEqual([['name', 'Ada']])
    expect(h.present.overlays.map((o) => o.id)).toContain('imported') // the import is untouched
    h = undo(h) // now the pre-load edit
    expect(formValues(h)).toEqual([])
    expect(canUndo(h)).toBe(false)
  })

  it('still coalesces edits made entirely after the load', () => {
    let h = loadIntoHistory(start(), { overlays: [], rotations: [], crops: [] })
    h = setFormValueInHistory(h, 'p1', 'name', 'A', geom(0))
    h = setFormValueInHistory(h, 'p1', 'name', 'Ad', geom(0))
    expect(h.past).toHaveLength(1) // the boundary closes the old step, it does not disable coalescing
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

describe('setFormValueInHistory', () => {
  it('inserts a formValue overlay on the first edit and upserts it thereafter', () => {
    let h = setFormValueInHistory(start(), 'p1', 'name', 'Ada', geom(0))
    expect(formValues(h)).toEqual([['name', 'Ada']])
    h = setFormValueInHistory(h, 'p1', 'email', 'ada@example.com', geom(0))
    expect(formValues(h)).toEqual([
      ['name', 'Ada'],
      ['email', 'ada@example.com']
    ])
    // Re-editing 'name' updates in place — it does not append a second overlay for the field.
    h = setFormValueInHistory(h, 'p1', 'name', 'Grace', geom(0))
    expect(formValues(h)).toEqual([
      ['name', 'Grace'],
      ['email', 'ada@example.com']
    ])
  })

  it('scopes fields by page, so the same field name on two pages stays independent', () => {
    let h = setFormValueInHistory(start(), 'p1', 'name', 'Ada', geom(0))
    h = setFormValueInHistory(h, 'p2', 'name', 'Grace', geom(0))
    expect(h.present.overlays).toHaveLength(2)
    expect(formValues(h)).toEqual([
      ['name', 'Ada'],
      ['name', 'Grace']
    ])
  })

  it('keeps an emptied value instead of removing the overlay (a cleared field stays cleared)', () => {
    let h = setFormValueInHistory(start(), 'p1', 'agree', true, geom(0))
    h = setFormValueInHistory(h, 'p1', 'agree', false, geom(0))
    expect(formValues(h)).toEqual([['agree', false]])
  })

  it('moves the dot and stamps control when a radio picks a different option', () => {
    let h = setFormValueInHistory(start(), 'p1', 'plan', 'basic', geom(10), 'radio')
    h = setFormValueInHistory(h, 'p1', 'plan', 'pro', geom(80), 'radio')
    const o = h.present.overlays[0]
    expect(o.type === 'formValue' && o.value).toBe('pro')
    expect(o.type === 'formValue' && o.control).toBe('radio')
    expect(o.geom.x).toBe(80) // the dot follows the newly-picked option's rect
  })

  it('coalesces a burst of edits to one field into a single undo step', () => {
    let h = setFormValueInHistory(start(), 'p1', 'name', 'A', geom(0))
    h = setFormValueInHistory(h, 'p1', 'name', 'Ad', geom(0))
    h = setFormValueInHistory(h, 'p1', 'name', 'Ada', geom(0))
    expect(h.past).toHaveLength(1)
    h = undo(h) // one undo wipes the whole burst, back to before the field existed
    expect(formValues(h)).toEqual([])
    expect(canUndo(h)).toBe(false)
    expect(formValues(redo(h))).toEqual([['name', 'Ada']]) // and redo replays all three
  })

  it('does not coalesce across different fields', () => {
    let h = setFormValueInHistory(start(), 'p1', 'name', 'Ada', geom(0))
    h = setFormValueInHistory(h, 'p1', 'email', 'a@b.c', geom(0))
    expect(h.past).toHaveLength(2)
    h = undo(h)
    expect(formValues(h)).toEqual([['name', 'Ada']]) // only the email edit is undone
  })
})

describe('overlay transforms (extracted from EditProvider)', () => {
  it('addOverlayInHistory appends one undoable overlay', () => {
    const h = addOverlayInHistory(start(), highlight('o1'))
    expect(h.present.overlays.map((o) => o.id)).toEqual(['o1'])
    expect(undo(h).present.overlays).toHaveLength(0)
  })

  it('replaceOverlayInHistory swaps in place by id', () => {
    let h = addOverlayInHistory(start(), highlight('o1'))
    h = addOverlayInHistory(h, highlight('o2'))
    const moved = { ...highlight('o1'), geom: geom(42) }
    h = replaceOverlayInHistory(h, moved)
    expect(h.present.overlays.map((o) => o.id)).toEqual(['o1', 'o2']) // order preserved
    expect(h.present.overlays[0].geom.x).toBe(42)
    expect(undo(h).present.overlays[0].geom.x).toBe(0)
  })

  it('replaceOverlayInHistory is a no-op (and records no undo step) for a missing id', () => {
    const h0 = addOverlayInHistory(start(), highlight('o1'))
    const h1 = replaceOverlayInHistory(h0, { ...highlight('ghost'), geom: geom(42) })
    expect(h1).toBe(h0) // unchanged history — no empty step to undo past
    expect(h1.past).toHaveLength(1)
  })

  it('removeOverlayInHistory removes exactly one overlay and is undoable', () => {
    let h = addOverlayInHistory(start(), highlight('o1'))
    h = addOverlayInHistory(h, highlight('o2'))
    h = addOverlayInHistory(h, highlight('o3'))
    h = removeOverlayInHistory(h, 'o2')
    expect(h.present.overlays.map((o) => o.id)).toEqual(['o1', 'o3'])
    expect(undo(h).present.overlays.map((o) => o.id)).toEqual(['o1', 'o2', 'o3'])
  })

  it('removeOverlayInHistory is a no-op for an unknown id', () => {
    const h0 = addOverlayInHistory(start(), highlight('o1'))
    const h1 = removeOverlayInHistory(h0, 'ghost')
    expect(h1).toBe(h0)
    expect(h1.present.overlays).toHaveLength(1)
  })
})
