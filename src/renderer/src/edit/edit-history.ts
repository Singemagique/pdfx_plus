// The undoable edit state and the pure transforms over it. Kept separate from EditProvider (which is
// React glue) so the reducer logic is unit-testable without a renderer.
//
// overlays, page rotations, and page crops all live in ONE history so undo/redo spans every content
// edit uniformly — rotating or cropping a page is as undoable as drawing on it. Rotations/crops are
// plain Records (not Maps) so Immer's well-tested object patches drive undo without enableMapSet; the
// React layer derives the public Map view.

import { apply, initHistory, type History } from './history'
import type { CropBox, Overlay } from './model'

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
 * Merge a loaded PDFX v1.1 mirror into the state as a CHECKPOINT: the loaded overlays/rotations/crops
 * join the present and the undo/redo stacks are reset. Opening a saved document is not itself an
 * undoable edit — so Ctrl+Z can no longer strip the just-loaded content in one lossy step (audit
 * P2-7), and any content already present is folded into the new baseline rather than lost.
 */
export function loadIntoHistory(
  h: History<EditState>,
  s: { overlays: Overlay[]; rotations: Array<[string, number]>; crops: Array<[string, CropBox]> }
): History<EditState> {
  const merged: EditState = {
    overlays: [...h.present.overlays, ...s.overlays],
    rotations: { ...h.present.rotations, ...Object.fromEntries(s.rotations) },
    crops: { ...h.present.crops, ...Object.fromEntries(s.crops) }
  }
  return initHistory(merged, h.limit)
}
