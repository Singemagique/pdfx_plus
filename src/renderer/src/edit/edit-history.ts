// The undoable edit state and the pure transforms over it. Kept separate from EditProvider (which is
// React glue) so the reducer logic is unit-testable without a renderer.
//
// overlays, page rotations, and page crops all live in ONE history so undo/redo spans every content
// edit uniformly — rotating or cropping a page is as undoable as drawing on it. Rotations/crops are
// plain Records (not Maps) so Immer's well-tested object patches drive undo without enableMapSet; the
// React layer derives the public Map view.

import { apply, type History } from './history'
import { newOverlayId, type CropBox, type Geom, type Overlay } from './model'

export interface EditState {
  overlays: Overlay[]
  /** Per-page extra rotation in degrees CW, keyed by page key (absent key = 0). */
  rotations: Record<string, number>
  /** Per-page crop rectangle (PDF points, bottom-left), keyed by page key. */
  crops: Record<string, CropBox>
}

export const emptyEditState = (): EditState => ({ overlays: [], rotations: {}, crops: {} })

/** Rotate a page by `delta` degrees (normalized to [0,360)); a net-zero rotation drops the key. */
export function rotateInHistory(
  h: History<EditState>,
  pageKey: string,
  delta: number
): History<EditState> {
  return apply(h, (d) => {
    const next = ((((d.rotations[pageKey] ?? 0) + delta) % 360) + 360) % 360
    if (next === 0) delete d.rotations[pageKey]
    else d.rotations[pageKey] = next
  })
}

/** Set (with a box) or clear (with null) a page's crop rectangle. Clearing an absent crop is a no-op
 *  (apply drops empty steps, so it records no undo entry). */
export function setCropInHistory(
  h: History<EditState>,
  pageKey: string,
  box: CropBox | null
): History<EditState> {
  return apply(h, (d) => {
    if (box) d.crops[pageKey] = box
    else delete d.crops[pageKey]
  })
}

/**
 * Merge a loaded PDFX v1.1 mirror into the present. The load itself is NOT an undoable step (no
 * patch is pushed), so Ctrl+Z can never strip the just-imported content in one lossy step (audit
 * P2-7) — but the user's PRE-IMPORT undo stack survives, so opening a document no longer silently
 * discards the work they did before it. Redo is cleared: those steps were recorded against a
 * present that no longer exists.
 *
 * TWO INVARIANTS make retaining `past` safe. Both are load-bearing — a future change that breaks
 * either one silently corrupts undo, because the retained steps are index/key-addressed Immer
 * patches recorded against the pre-load present:
 *
 *  1. LOADED OVERLAYS APPEND AT THE TAIL. Existing steps address overlays by array INDEX
 *     (`/overlays/3/...`), so anything already in `present.overlays` must keep its index. Never
 *     reorder this merge to prepend the loaded overlays, or to sort/dedupe the result.
 *  2. LOADED PAGE KEYS CANNOT COLLIDE WITH PRE-LOAD ONES. rotations/crops are keyed by page key,
 *     and a retained step's inverse patch targets one of those keys. Every import mints fresh
 *     source UUIDs (loadSource in ../pdfx/source.ts), and makePageKey derives from the source id,
 *     so a loaded page's key is always new. Never reuse a source id across imports.
 *  3. THE LOAD IS A COALESCE BOUNDARY. history.apply folds a new step into the top of `past` when
 *     the two share a coalesceKey, so a retained top step would keep absorbing post-load edits to
 *     the same target (e.g. the same form field on a page that survived the load): one Ctrl+Z
 *     would then revert across the import, undoing pre- and post-load typing together. The top
 *     retained step therefore has its coalesceKey stripped below — nothing after the load can
 *     merge into anything recorded before it.
 */
export function loadIntoHistory(
  h: History<EditState>,
  s: { overlays: Overlay[]; rotations: Array<[string, number]>; crops: Array<[string, CropBox]> }
): History<EditState> {
  const merged: EditState = {
    overlays: [...h.present.overlays, ...s.overlays], // invariant 1: append, never prepend
    rotations: { ...h.present.rotations, ...Object.fromEntries(s.rotations) },
    crops: { ...h.present.crops, ...Object.fromEntries(s.crops) }
  }
  // invariant 3: close the top retained step so no post-load edit coalesces into a pre-load one.
  const past = h.past.length
    ? [...h.past.slice(0, -1), { ...h.past[h.past.length - 1], coalesceKey: undefined }]
    : h.past
  return { ...h, present: merged, past, future: [] }
}

/**
 * Upsert a form field's value as a formValue overlay. Always an upsert (never an auto-remove) so a
 * cleared/unchecked field stays cleared in the editor; flatten draws only non-empty values, so ''
 * and false paint nothing. Consecutive edits to the SAME field coalesce into one undo step, so
 * typing doesn't flood (and evict) the bounded undo stack.
 */
export function setFormValueInHistory(
  h: History<EditState>,
  pageKey: string,
  field: string,
  value: string | boolean,
  geom: Geom,
  control?: 'radio'
): History<EditState> {
  return apply(
    h,
    (d) => {
      const i = d.overlays.findIndex(
        (o) => o.type === 'formValue' && o.pageKey === pageKey && o.field === field
      )
      if (i >= 0) {
        const o = d.overlays[i] as Extract<Overlay, { type: 'formValue' }>
        o.value = value
        o.geom = geom // a radio moves the dot to the newly-picked option's rect
        o.control = control
      } else
        d.overlays.push({
          id: newOverlayId(),
          pageKey,
          z: d.overlays.length,
          createdAt: Date.now(),
          geom,
          type: 'formValue',
          field,
          value,
          ...(control ? { control } : {})
        })
    },
    `formValue:${pageKey}:${field}`
  )
}

/** Append an overlay as one undo step. */
export function addOverlayInHistory(h: History<EditState>, o: Overlay): History<EditState> {
  return apply(h, (d) => {
    d.overlays.push(o)
  })
}

/** Replace an overlay in place by id; an unknown id is a no-op (and records no undo step). */
export function replaceOverlayInHistory(h: History<EditState>, next: Overlay): History<EditState> {
  return apply(h, (d) => {
    const i = d.overlays.findIndex((o) => o.id === next.id)
    if (i >= 0) d.overlays[i] = next
  })
}

/** Remove the overlay with `id`; an unknown id is a no-op (and records no undo step). */
export function removeOverlayInHistory(h: History<EditState>, id: string): History<EditState> {
  return apply(h, (d) => {
    const i = d.overlays.findIndex((o) => o.id === id)
    if (i >= 0) d.overlays.splice(i, 1)
  })
}
