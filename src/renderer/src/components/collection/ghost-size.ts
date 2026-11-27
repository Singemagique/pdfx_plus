import { BASE_PAGE_HEIGHT, pageDisplayWidth } from '../../canvas/layout'
import type { CanvasLayout, DropTarget, DropView } from '../../canvas/layout'
import type { GhostSize } from '../DropGhost'
import type { PageRef } from '../../app/types'

type DragKind = 'internal' | 'external' | null

const LETTER_PAGE = { width: 612, height: 792 }
const MAX_BETWEEN_GHOSTS = 3

export const LETTER_GHOST: GhostSize = {
  width: pageDisplayWidth(LETTER_PAGE.width, LETTER_PAGE.height),
  height: BASE_PAGE_HEIGHT
}

/** A page's ghost: the size its cell is drawn at in the layout (rotation included). */
function slotGhostSize(layout: CanvasLayout, docId: string, pageId: string): GhostSize | null {
  const slot = layout.items.find((i) => i.doc.id === docId)?.pages.find((p) => p.pageId === pageId)
  return slot ? { width: slot.w, height: slot.h } : null
}

export function intoGhostSize(
  layout: CanvasLayout,
  intoDocId: string | null,
  intoIndex: number,
  dragKind: DragKind,
  draggedSize: GhostSize | null
): GhostSize {
  if (!intoDocId) return LETTER_GHOST
  if (dragKind === 'internal' && draggedSize) return draggedSize
  const target = layout.items.find((i) => i.doc.id === intoDocId)
  const ref = target?.pages[Math.min(intoIndex, target.pages.length - 1)]
  return ref ? { width: ref.w, height: ref.h } : LETTER_GHOST
}

export function betweenGhostPages(
  dragKind: DragKind,
  draggedSize: GhostSize | null,
  externalCount: number
): GhostSize[] {
  if (dragKind === 'internal' && draggedSize) return [draggedSize]
  const count = Math.max(1, Math.min(MAX_BETWEEN_GHOSTS, externalCount))
  return Array.from({ length: count }, () => LETTER_GHOST)
}

export interface DropGhosts {
  intoDocId: string | null
  intoIndex: number
  betweenIndex: number
  ghostSize: GhostSize
  betweenPages: GhostSize[]
}

export function deriveDropGhosts(
  layout: CanvasLayout,
  draggingPage: PageRef | null,
  dropTarget: DropTarget | null,
  dragKind: DragKind,
  externalCount: number
): DropGhosts {
  const draggedSize = draggingPage
    ? slotGhostSize(layout, draggingPage.docId, draggingPage.pageId)
    : null
  const intoDocId = dropTarget?.kind === 'into' ? dropTarget.docId : null
  const intoIndex = dropTarget?.kind === 'into' ? dropTarget.index : -1
  const betweenIndex = dropTarget?.kind === 'between' ? dropTarget.docIndex : -1
  return {
    intoDocId,
    intoIndex,
    betweenIndex,
    ghostSize: intoGhostSize(layout, intoDocId, intoIndex, dragKind, draggedSize),
    betweenPages: betweenGhostPages(dragKind, draggedSize, externalCount)
  }
}

/**
 * The drop preview on screen as the hit test needs it (see computeDropTarget): the drawn target,
 * the into-ghost width it is drawn with, and the width it would take at any other index of the
 * same document — sized exactly as deriveDropGhosts sizes it for CollectionCanvas.
 */
export function deriveDropView(
  layout: CanvasLayout,
  draggingPage: PageRef | null,
  dropTarget: DropTarget | null,
  dragKind: DragKind
): DropView {
  const draggedSize = draggingPage
    ? slotGhostSize(layout, draggingPage.docId, draggingPage.pageId)
    : null
  const intoDocId = dropTarget?.kind === 'into' ? dropTarget.docId : null
  const widthAt = (index: number): number =>
    intoGhostSize(layout, intoDocId, index, dragKind, draggedSize).width
  const ghostWidth = widthAt(dropTarget?.kind === 'into' ? dropTarget.index : -1)
  return { target: dropTarget, ghostWidth, ghostWidthAt: widthAt }
}
