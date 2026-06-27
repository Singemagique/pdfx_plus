import { describe, expect, it } from 'vitest'

import { apply, canRedo, canUndo, initHistory, redo, undo } from './history'

interface State {
  items: number[]
}

const start = (): ReturnType<typeof initHistory<State>> => initHistory<State>({ items: [] })

describe('history', () => {
  it('applies a mutation, recording an undoable step', () => {
    const h = apply(start(), (d) => {
      d.items.push(1)
    })
    expect(h.present.items).toEqual([1])
    expect(canUndo(h)).toBe(true)
    expect(canRedo(h)).toBe(false)
  })

  it('treats a no-op recipe as a no-op (no empty undo entry, same reference)', () => {
    const h0 = start()
    const h1 = apply(h0, () => {
      /* touch nothing */
    })
    expect(h1).toBe(h0)
    expect(canUndo(h1)).toBe(false)
  })

  it('undoes and redoes a change', () => {
    let h = apply(start(), (d) => {
      d.items.push(1)
    })
    h = apply(h, (d) => {
      d.items.push(2)
    })
    expect(h.present.items).toEqual([1, 2])

    h = undo(h)
    expect(h.present.items).toEqual([1])
    expect(canRedo(h)).toBe(true)

    h = redo(h)
    expect(h.present.items).toEqual([1, 2])
  })

  it('clears the redo stack when a new change is applied after an undo', () => {
    let h = apply(start(), (d) => {
      d.items.push(1)
    })
    h = undo(h)
    expect(canRedo(h)).toBe(true)
    h = apply(h, (d) => {
      d.items.push(9)
    })
    expect(h.present.items).toEqual([9])
    expect(canRedo(h)).toBe(false)
  })

  it('does not mutate the previous present (immutability)', () => {
    const h0 = apply(start(), (d) => {
      d.items.push(1)
    })
    const h1 = apply(h0, (d) => {
      d.items.push(2)
    })
    expect(h0.present.items).toEqual([1])
    expect(h1.present.items).toEqual([1, 2])
  })

  it('coalesces consecutive applies sharing a key into one undo step', () => {
    interface S {
      v: string
    }
    let h = initHistory<S>({ v: '' })
    h = apply(h, (d) => void (d.v = 'a')) // separate, no key
    for (const ch of ['A', 'Ad', 'Ada']) h = apply(h, (d) => void (d.v = ch), 'field:name')
    expect(h.present.v).toBe('Ada')
    expect(h.past.length).toBe(2) // the 'a' step + ONE coalesced typing step (not 4)
    h = undo(h)
    expect(h.present.v).toBe('a') // one undo reverts the whole typing burst
    h = redo(h)
    expect(h.present.v).toBe('Ada')
  })

  it('does not coalesce across different keys (or once the burst is interrupted)', () => {
    interface S {
      v: string
    }
    let h = initHistory<S>({ v: '' })
    h = apply(h, (d) => void (d.v = 'x'), 'field:a')
    h = apply(h, (d) => void (d.v = 'y'), 'field:b') // different key → new step
    expect(h.past.length).toBe(2)
    h = undo(h)
    expect(h.present.v).toBe('x')
  })

  it('coalesced typing cannot flood the bounded stack and evict older edits', () => {
    interface S {
      v: string
    }
    let h = initHistory<S>({ v: '' }, 3)
    h = apply(h, (d) => void (d.v = 'keep')) // an earlier, distinct edit
    for (let i = 0; i < 50; i++) h = apply(h, (d) => void (d.v = `t${i}`), 'field:name')
    expect(h.past.length).toBe(2) // 'keep' + one coalesced typing step — not evicted
    h = undo(h) // undo the typing
    h = undo(h) // undo 'keep'
    expect(h.present.v).toBe('')
  })

  it('bounds the undo stack to its limit, dropping the oldest steps', () => {
    let h = initHistory<State>({ items: [] }, 3)
    for (let i = 0; i < 10; i++) {
      h = apply(h, (d) => {
        d.items.push(i)
      })
    }
    expect(h.present.items).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(h.past.length).toBe(3) // only the last 3 steps are undoable
    h = undo(h)
    h = undo(h)
    h = undo(h)
    expect(h.present.items).toEqual([0, 1, 2, 3, 4, 5, 6]) // unwound only 3 pushes
    expect(canUndo(h)).toBe(false)
  })
})
