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

/** The drop preview on screen: the target the last hit test chose and the into-ghost width it is drawn with. */
export interface DropView {
  target: DropTarget | null
  ghostWidth: number
}

/** Below this on-screen height of a one-row card, every drop targets the gaps between documents. */
const INTO_MIN_SCREEN_PX = 90

/** `excludeId` when the page being dragged out lives in `item`, else null. */
function excludedFrom(item: DocPlacement, excludeId: string | null): string | null {
  return excludeId && item.pages.some((p) => p.pageId === excludeId) ? excludeId : null
}

/**
 * The visible insertion index for a drop at (wx, wy) inside `item`: pick the wrapped row by y
 * (nearest row — the header band counts as the first row, anything below as the last), then the
 * slot by x against each page's midpoint. Positions come from the layout itself (re-flowed without
 * the dragged page when it lives in this document), so rotated pages and multi-row cards are hit
 * exactly where they are drawn.
 *
 * A trailing row can hold no page — one emptied by the page being dragged out of this document. A
 * drop on such a row appends; it must not be matched by x against the pages of the row above.
 */
function insertionIndex(
  item: DocPlacement,
  wx: number,
  wy: number,
  excludeId: string | null
): number {
  const exclude = excludedFrom(item, excludeId)
  const slots: PageSlot[] = exclude ? reflowDoc(item, exclude, null).pages : item.pages
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

/** How much taller an into-ghost of width `w` at visible index `index` makes `item` (≥ 0). */
function growthAt(item: DocPlacement, excludeId: string | null, index: number, w: number): number {
  const reflow = reflowDoc(item, excludedFrom(item, excludeId), { index, w })
  return Math.max(0, reflow.height - item.height)
}

type IntoTarget = Extract<DropTarget, { kind: 'into' }>

interface Grown {
  /** Layout index of the card the drawn into-ghost grew, or -1. */
  at: number
  grow: number
  target: IntoTarget | null
}

/**
 * How far the into-ghost on screen has grown its card: a ghost that wraps the target onto an extra
 * row makes the card that much taller and slides every later card down by it (see
 * components/collection/drag-view.ts, which draws it from the same reflowDoc call).
 */
function drawnGrowth(layout: CanvasLayout, excludeId: string | null, view: DropView | null): Grown {
  const none: Grown = { at: -1, grow: 0, target: null }
  const target = view?.target
  if (!view || target?.kind !== 'into') return none
  const at = layout.items.findIndex((i) => i.doc.id === target.docId)
  if (at < 0) return none
  const grow = growthAt(layout.items[at], excludeId, target.index, view.ghostWidth)
  return grow > 0 ? { at, grow, target } : none
}

/**
 * The target for a point on the row(s) a drawn into-ghost added below its card's own rows: the end
 * of the document — the ghost moves under the pointer — when an appended ghost would also reach
 * down that far, else the target drawn now. Either is a fixed point: re-testing against the
 * geometry it draws gives the same answer, so the target cannot oscillate.
 */
function onGrownRows(
  item: DocPlacement,
  excludeId: string | null,
  drawn: IntoTarget,
  depth: number,
  ghostWidth: number
): DropTarget {
  const end = item.pages.length - (excludedFrom(item, excludeId) ? 1 : 0)
  if (end === drawn.index) return drawn
  return growthAt(item, excludeId, end, ghostWidth) >= depth
    ? { kind: 'into', docId: item.doc.id, index: end }
    : drawn
}

/**
 * The drop target under world point (worldX, worldY).
 *
 * `view` is the preview currently drawn. When its into-ghost has grown the target card by a row,
 * hit-testing uses that drawn geometry — the card reaches down over the ghost's row and later
 * cards sit lower — so moving onto the ghost does not flip the target to "between documents" and
 * back. A point on that added row is not matched against the pages the ghost displaced onto it
 * (they only sit there because of the current target); see onGrownRows.
 */
export function computeDropTarget(
  layout: CanvasLayout,
  worldX: number,
  worldY: number,
  scale: number,
  excludeId: string | null,
  allowInto: boolean,
  view: DropView | null = null
): DropTarget {
  const items = layout.items
  const { at, grow, target: drawn } = drawnGrowth(layout, excludeId, view)
  const top = (i: number): number => items[i].y + (at >= 0 && i > at ? grow : 0)
  const height = (i: number): number => items[i].height + (i === at ? grow : 0)

  if (allowInto && SINGLE_ROW_DOC_HEIGHT * scale >= INTO_MIN_SCREEN_PX) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      const y0 = top(i)
      if (worldY < y0 || worldY > y0 + height(i)) continue
      const depth = worldY - (y0 + item.height)
      if (i === at && drawn && view && depth > 0) {
        return onGrownRows(item, excludeId, drawn, depth, view.ghostWidth)
      }
      return {
        kind: 'into',
        docId: item.doc.id,
        index: insertionIndex(item, worldX, worldY - (y0 - item.y), excludeId)
      }
    }
  }
  let docIndex = 0
  for (let i = 0; i < items.length; i++) {
    if (top(i) + height(i) / 2 < worldY) docIndex++
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
