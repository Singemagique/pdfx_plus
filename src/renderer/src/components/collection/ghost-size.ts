import { BASE_PAGE_HEIGHT, pageDisplayWidth } from '../../canvas/layout'
import type { DropTarget } from '../../canvas/layout'
import type { GhostSize } from '../DropGhost'
import type { PageRef } from '../../app/types'
import type { DocEntry, PageEntry } from '../../types'

type DragKind = 'internal' | 'external' | null

const LETTER_PAGE = { width: 612, height: 792 }
const MAX_BETWEEN_GHOSTS = 3

export const LETTER_GHOST: GhostSize = {
  width: pageDisplayWidth(LETTER_PAGE.width, LETTER_PAGE.height),
  height: BASE_PAGE_HEIGHT
}

export function pageGhostSize(page: PageEntry): GhostSize {
  return { width: pageDisplayWidth(page.width, page.height), height: BASE_PAGE_HEIGHT }
}

export function intoGhostSize(
  docs: DocEntry[],
  intoDocId: string | null,
  intoIndex: number,
  dragKind: DragKind,
  draggedSize: GhostSize | null
): GhostSize {
  if (!intoDocId) return LETTER_GHOST
  if (dragKind === 'internal' && draggedSize) return draggedSize
  const target = docs.find((d) => d.id === intoDocId)
  const ref = target?.pages[Math.min(intoIndex, target.pages.length - 1)]
  return ref ? pageGhostSize(ref) : LETTER_GHOST
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
  docs: DocEntry[],
  draggingPage: PageRef | null,
  dropTarget: DropTarget | null,
  dragKind: DragKind,
  externalCount: number
): DropGhosts {
  const draggedEntry = draggingPage
    ? docs.find((d) => d.id === draggingPage.docId)?.pages.find((p) => p.id === draggingPage.pageId)
    : undefined
  const draggedSize = draggedEntry ? pageGhostSize(draggedEntry) : null
  const intoDocId = dropTarget?.kind === 'into' ? dropTarget.docId : null
  const intoIndex = dropTarget?.kind === 'into' ? dropTarget.index : -1
  const betweenIndex = dropTarget?.kind === 'between' ? dropTarget.docIndex : -1
  return {
    intoDocId,
    intoIndex,
    betweenIndex,
    ghostSize: intoGhostSize(docs, intoDocId, intoIndex, dragKind, draggedSize),
    betweenPages: betweenGhostPages(dragKind, draggedSize, externalCount)
  }
}
