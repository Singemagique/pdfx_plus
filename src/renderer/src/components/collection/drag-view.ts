import { BETWEEN_GHOST_SHIFT, reflowDoc } from '../../canvas/layout'
import type { CanvasLayout, DocReflow } from '../../canvas/layout'

export interface DragViewInput {
  /** The dragged page once it has collapsed out of its document, and that document's id. */
  collapsedId: string | null
  draggingDocId: string | null
  intoDocId: string | null
  intoIndex: number
  intoGhostWidth: number
  /** The into-ghost's height (a page whose cell is shorter than the row, see MAX_CELL_WIDTH). */
  intoGhostHeight?: number
  betweenIndex: number
}

export interface DragView {
  /** Mid-drag page positions for the documents a drag reshapes (by doc id). */
  reflows: Map<string, DocReflow>
  /** Vertical offset applied to each document card (and its header), in layout order. */
  shifts: number[]
}

/**
 * How the column looks mid-drag. The source document closes up around the collapsed page, the
 * target document opens an into-ghost (both re-flowed with the layout's own wrap), and every card
 * below either the between-documents ghost or a target that grew by a row slides down to make room.
 */
export function computeDragView(layout: CanvasLayout, input: DragViewInput): DragView {
  const reflows = new Map<string, DocReflow>()
  const shifts: number[] = []
  let extra = 0
  layout.items.forEach((item, index) => {
    const between =
      input.betweenIndex !== -1 && index >= input.betweenIndex ? BETWEEN_GHOST_SHIFT : 0
    shifts.push(between + extra)
    const id = item.doc.id
    const excludeId = input.collapsedId && input.draggingDocId === id ? input.collapsedId : null
    const into = input.intoDocId === id
    if (!excludeId && !into) return
    const reflow = reflowDoc(
      item,
      excludeId,
      into ? { index: input.intoIndex, w: input.intoGhostWidth, h: input.intoGhostHeight } : null
    )
    reflows.set(id, reflow)
    extra += Math.max(0, reflow.height - item.height)
  })
  return { reflows, shifts }
}
