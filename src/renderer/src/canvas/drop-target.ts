import type { DocPlacement, CanvasLayout, PageSlot } from './layout'
import {
  BASE_PAGE_HEIGHT,
  DOC_GAP_Y,
  PAGES_TOP,
  ROW_GAP,
  SINGLE_ROW_DOC_HEIGHT,
  reflowDoc
} from './layout'

export type DropTarget =
  | { kind: 'into'; docId: string; index: number }
  | { kind: 'between'; docIndex: number }

/** Below this on-screen height of a one-row card, every drop targets the gaps between documents. */
const INTO_MIN_SCREEN_PX = 90

/**
 * The visible insertion index for a drop at (wx, wy) inside `item`: pick the wrapped row by y
 * (nearest row — the header band counts as the first row, anything below as the last), then the
 * slot by x against each page's midpoint. Positions come from the layout itself (re-flowed without
 * the dragged page when it lives in this document), so rotated pages and multi-row cards are hit
 * exactly where they are drawn.
 *
 * The card is drawn with all `item.rows` rows, and the trailing ones can hold no page: the row the
 * add-page slot sits on alone, or a row emptied by the page being dragged out of this document. A
 * drop on such a row appends — it must not be matched by x against the pages of the row above.
 */
function insertionIndex(
  item: DocPlacement,
  wx: number,
  wy: number,
  excludeId: string | null
): number {
  const slots: PageSlot[] =
    excludeId && item.pages.some((p) => p.pageId === excludeId)
      ? reflowDoc(item, excludeId, null).pages
      : item.pages
  if (slots.length === 0) return 0

  // Not a module constant: layout.ts re-exports this module, so its constants aren't initialised
  // yet when this module first evaluates.
  const pitch = BASE_PAGE_HEIGHT + ROW_GAP
  const nearest = Math.floor((wy - item.y - PAGES_TOP + ROW_GAP / 2) / pitch)
  const row = Math.max(0, Math.min(item.rows - 1, nearest))
  if (row > slots[slots.length - 1].row) return slots.length

  let index = slots.findIndex((s) => s.row === row)
  for (; index < slots.length && slots[index].row === row; index++) {
    const s = slots[index]
    if (wx <= s.x + s.w / 2) return index
  }
  return index
}

export function computeDropTarget(
  layout: CanvasLayout,
  worldX: number,
  worldY: number,
  scale: number,
  excludeId: string | null,
  allowInto: boolean
): DropTarget {
  const items = layout.items
  if (allowInto && SINGLE_ROW_DOC_HEIGHT * scale >= INTO_MIN_SCREEN_PX) {
    for (const item of items) {
      if (worldY >= item.y && worldY <= item.y + item.height) {
        return {
          kind: 'into',
          docId: item.doc.id,
          index: insertionIndex(item, worldX, worldY, excludeId)
        }
      }
    }
  }
  let docIndex = 0
  for (const item of items) {
    if (item.y + item.height / 2 < worldY) docIndex++
  }
  return { kind: 'between', docIndex }
}

/** World y where the between-documents ghost opens for a drop at `docIndex`. */
export function betweenSlotY(layout: CanvasLayout, docIndex: number): number {
  const items = layout.items
  if (items.length === 0) return 0
  if (docIndex >= items.length) {
    const last = items[items.length - 1]
    return last.y + last.height + DOC_GAP_Y
  }
  return items[Math.max(0, docIndex)].y
}
