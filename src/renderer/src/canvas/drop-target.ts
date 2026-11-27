import type { DocPlacement, CanvasLayout, PageSlot } from './layout'
import { DOC_GAP_Y, ROW_GAP, SINGLE_ROW_DOC_HEIGHT, reflowDoc } from './layout'

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

  const lastRow = slots[slots.length - 1].row
  let row = 0
  for (let r = 1; r <= lastRow; r++) {
    const top = slots.find((s) => s.row === r)?.y
    if (top !== undefined && wy >= top - ROW_GAP / 2) row = r
  }

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
