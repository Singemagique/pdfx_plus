// Undo/redo over the edit state via Immer patches (PRD §4.2).
//
// Each mutation stores the forward + inverse patch set rather than a full snapshot, so
// memory stays proportional to edit size, not document size. The same store can back
// structural ops for a single unified undo timeline.
//
// Coalescing of continuous gestures (drag, freehand ink) is the caller's responsibility:
// apply() once per *completed* gesture (e.g. on pointer-up), not per pointer-move.

import {
  applyPatches,
  enablePatches,
  produceWithPatches,
  type Draft,
  type Objectish,
  type Patch
} from 'immer'

enablePatches()

interface Step {
  redo: Patch[]
  undo: Patch[]
  /** Consecutive applies sharing a coalesce key merge into one step (e.g. typing in a field). */
  coalesceKey?: string
}

export interface History<S extends Objectish> {
  present: S
  past: Step[]
  future: Step[]
  /** Max retained undo steps; older steps are dropped. */
  limit: number
}

const DEFAULT_LIMIT = 100

export function initHistory<S extends Objectish>(
  present: S,
  limit: number = DEFAULT_LIMIT
): History<S> {
  return { present, past: [], future: [], limit: Math.max(1, limit) }
}

/**
 * Apply a mutation described by an Immer recipe. Pushes the resulting patches onto the
 * undo stack, clears the redo stack, and bounds the undo stack to `limit`. If the recipe
 * produces no change, the history is returned unchanged (no empty undo entry).
 *
 * When `coalesceKey` matches the most recent step's key, the new patches are folded into that
 * step instead of pushing a new one — so a burst of rapid edits to the same target (e.g. typing
 * into one form field) is a single undo, and can't flood the bounded stack and evict older edits.
 */
export function apply<S extends Objectish>(
  history: History<S>,
  recipe: (draft: Draft<S>) => void,
  coalesceKey?: string
): History<S> {
  const [next, redo, undo] = produceWithPatches(history.present, recipe)
  if (redo.length === 0) return history
  const top = history.past[history.past.length - 1]
  if (coalesceKey && top && top.coalesceKey === coalesceKey) {
    // Sequential patch application: prev.redo then redo reproduces the full forward change;
    // undo then prev.undo reverses it. Keeps it one undo step.
    const merged: Step = {
      redo: [...top.redo, ...redo],
      undo: [...undo, ...top.undo],
      coalesceKey
    }
    return { ...history, present: next, past: [...history.past.slice(0, -1), merged], future: [] }
  }
  const past = [...history.past, { redo, undo, coalesceKey }]
  if (past.length > history.limit) past.splice(0, past.length - history.limit)
  return { ...history, present: next, past, future: [] }
}

export const canUndo = <S extends Objectish>(h: History<S>): boolean => h.past.length > 0
export const canRedo = <S extends Objectish>(h: History<S>): boolean => h.future.length > 0

export function undo<S extends Objectish>(history: History<S>): History<S> {
  const step = history.past[history.past.length - 1]
  if (!step) return history
  return {
    ...history,
    present: applyPatches(history.present, step.undo),
    past: history.past.slice(0, -1),
    future: [step, ...history.future]
  }
}

export function redo<S extends Objectish>(history: History<S>): History<S> {
  const step = history.future[0]
  if (!step) return history
  return {
    ...history,
    present: applyPatches(history.present, step.redo),
    past: [...history.past, step],
    future: history.future.slice(1)
  }
}
