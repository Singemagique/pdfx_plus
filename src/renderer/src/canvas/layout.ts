import type { DocEntry, PageEntry } from '../types'
import { makePageKey } from '../edit/model'
import { FIT_MARGIN, TARGET_FIT_SCALE } from './zoom-constants'

export type Rotations = Map<string, number>

const isRotated = (rot: number | undefined): boolean => rot === 90 || rot === 270

/** World-px height of every page thumbnail. */
export const BASE_PAGE_HEIGHT = 280
/** Horizontal gap between pages in a row. */
export const PAGE_GAP = 18
/** Vertical gap between the wrapped rows of one document. */
export const ROW_GAP = 18
/** Left/right inset of the page grid inside a document card (card padding + grid padding). */
export const CARD_PAD_X = 16 + 6
/** Top of the first page row inside a card — the band the document header sits in. */
export const PAGES_TOP = 52
const CARD_PAD_BOTTOM = 14
export const DOC_GAP_Y = 30

/** Height of a document card holding exactly one row of pages. */
export const SINGLE_ROW_DOC_HEIGHT = PAGES_TOP + BASE_PAGE_HEIGHT + CARD_PAD_BOTTOM
/** The between-documents drop ghost row (its top padding is a little tighter than a card's). */
const GHOST_ROW_PAD_TOP = 42
export const GHOST_ROW_HEIGHT = GHOST_ROW_PAD_TOP + BASE_PAGE_HEIGHT + CARD_PAD_BOTTOM
/** How far later documents slide down to open room for the between-documents ghost. */
export const BETWEEN_GHOST_SHIFT = GHOST_ROW_HEIGHT + DOC_GAP_Y

/**
 * Letter pages per row at the narrowest wrap. Small enough that a narrow window (down to ~850 css
 * px of canvas) still wraps to fewer columns at about TARGET_FIT_SCALE instead of shrinking a wide
 * row; and exactly the room the between-documents ghost needs for its up-to-three page ghosts.
 */
const MIN_PAGES = 3
const REF_PAGE_WIDTH = Math.round((BASE_PAGE_HEIGHT * 612) / 792)
export const MIN_DOC_WIDTH =
  MIN_PAGES * REF_PAGE_WIDTH + (MIN_PAGES - 1) * PAGE_GAP + CARD_PAD_X * 2

export const ADD_PAGE_WIDTH = REF_PAGE_WIDTH

/** Viewport width assumed before the canvas has been measured (one pre-paint frame, and tests). */
const DEFAULT_VIEWPORT_WIDTH = 1440

/**
 * The world-px width documents wrap to for a canvas viewport `viewportWidth` css px wide.
 *
 * The fit scales content so its width fills FIT_MARGIN of the viewport, so wrapping at
 * `viewportWidth · FIT_MARGIN / TARGET_FIT_SCALE` makes a full row land at TARGET_FIT_SCALE once
 * fitted — i.e. thumbnails come up at their designed ~280 css px height instead of shrinking with
 * the page count. Never narrower than MIN_DOC_WIDTH, so a tiny window still gets a usable row.
 */
export function wrapWidthForViewport(viewportWidth: number): number {
  return Math.max(MIN_DOC_WIDTH, Math.round((viewportWidth * FIT_MARGIN) / TARGET_FIT_SCALE))
}

export const DEFAULT_WRAP_WIDTH = wrapWidthForViewport(DEFAULT_VIEWPORT_WIDTH)

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** One page's cell in WORLD coordinates. `row` is its wrapped row within the document. */
export interface PageSlot extends Rect {
  pageId: string
  row: number
}

export interface DocPlacement {
  doc: DocEntry
  x: number
  y: number
  width: number
  height: number
  /** Number of wrapped page rows (the add-page slot included). */
  rows: number
  /** The width rows wrap to (outer card width, padding included). */
  wrapWidth: number
  /** Every page's cell, in document order — the single source of truth for pixels and hit tests. */
  pages: PageSlot[]
  /** The trailing "Add page" slot. */
  addPage: Rect
}

export interface CanvasLayout {
  items: DocPlacement[]
  contentWidth: number
  contentHeight: number
  wrapWidth: number
}

export function pageDisplayWidth(width: number, height: number): number {
  return Math.max(6, Math.round((BASE_PAGE_HEIGHT * width) / height))
}

/** Display width at the fixed thumbnail height, accounting for a 90°/270° rotation. */
export function pageCellWidth(page: PageEntry, rotations?: Rotations): number {
  const rot = rotations?.get(makePageKey(page.source.id, page.pageIndex))
  return isRotated(rot)
    ? pageDisplayWidth(page.height, page.width)
    : pageDisplayWidth(page.width, page.height)
}

export interface FlowPosition {
  /** Left edge relative to the start of the grid. */
  x: number
  row: number
}

/**
 * Greedy row wrapping: cells go left to right and a cell that would overrun `maxRowWidth` starts a
 * new row — except the first cell of a row, which always stays, so a page wider than the wrap
 * width gets a row to itself instead of looping forever.
 */
export function flowCells(widths: readonly number[], maxRowWidth: number): FlowPosition[] {
  const out: FlowPosition[] = []
  let x = 0
  let row = 0
  let inRow = 0
  for (const w of widths) {
    if (inRow > 0 && x + PAGE_GAP + w > maxRowWidth) {
      row++
      x = 0
      inRow = 0
    }
    if (inRow > 0) x += PAGE_GAP
    out.push({ x, row })
    x += w
    inRow++
  }
  return out
}

/** Card height for `rows` rows of pages. */
export function docHeightForRows(rows: number): number {
  const r = Math.max(1, rows)
  return PAGES_TOP + r * BASE_PAGE_HEIGHT + (r - 1) * ROW_GAP + CARD_PAD_BOTTOM
}

const rowTop = (docY: number, row: number): number =>
  docY + PAGES_TOP + row * (BASE_PAGE_HEIGHT + ROW_GAP)

const innerWidth = (wrapWidth: number): number => wrapWidth - CARD_PAD_X * 2

export interface FlowedCell extends Rect {
  row: number
}

/** Flow `widths` into a card at (docX, docY) wrapping at `wrapWidth`; world-coordinate cells. */
export function flowDoc(
  widths: readonly number[],
  docX: number,
  docY: number,
  wrapWidth: number
): { cells: FlowedCell[]; rows: number; extent: number } {
  const positions = flowCells(widths, innerWidth(wrapWidth))
  let rows = 1
  let extent = 0
  const cells = positions.map((p, i) => {
    rows = Math.max(rows, p.row + 1)
    extent = Math.max(extent, p.x + widths[i])
    return {
      x: docX + CARD_PAD_X + p.x,
      y: rowTop(docY, p.row),
      w: widths[i],
      h: BASE_PAGE_HEIGHT,
      row: p.row
    }
  })
  return { cells, rows, extent }
}

function placeDoc(
  doc: DocEntry,
  y: number,
  wrapWidth: number,
  rotations?: Rotations
): DocPlacement {
  const widths = doc.pages.map((p) => pageCellWidth(p, rotations))
  widths.push(ADD_PAGE_WIDTH)
  const { cells, rows, extent } = flowDoc(widths, 0, y, wrapWidth)
  const add = cells[cells.length - 1]
  return {
    doc,
    x: 0,
    y,
    width: Math.max(MIN_DOC_WIDTH, extent + CARD_PAD_X * 2),
    height: docHeightForRows(rows),
    rows,
    wrapWidth,
    pages: doc.pages.map((p, i) => ({ pageId: p.id, ...cells[i] })),
    addPage: { x: add.x, y: add.y, w: add.w, h: add.h }
  }
}

/**
 * Lay the collection out as a column of document cards, each wrapping its pages into rows no wider
 * than `wrapWidth` world px (clamped to at least MIN_DOC_WIDTH). Card heights follow their row
 * count, and each card's y is the cumulative height of those above it.
 */
export function computeLayout(
  docs: DocEntry[],
  rotations?: Rotations,
  wrapWidth: number = DEFAULT_WRAP_WIDTH
): CanvasLayout {
  const wrap = Math.max(MIN_DOC_WIDTH, wrapWidth)
  let y = 0
  const items = docs.map((doc) => {
    const placement = placeDoc(doc, y, wrap, rotations)
    y += placement.height + DOC_GAP_Y
    return placement
  })
  const contentWidth = Math.max(1, ...items.map((i) => i.width))
  // Every card spans the collection's width so the right edges line up.
  for (const item of items) item.width = contentWidth
  // The trailing "Add document" row sits one gap below the last card.
  const contentHeight = items.length > 0 ? y + SINGLE_ROW_DOC_HEIGHT : 1
  return { items, contentWidth, contentHeight, wrapWidth: wrap }
}

export interface DocReflow {
  /** Page cells (excluded page omitted) in visible order, world coordinates. */
  pages: PageSlot[]
  /** Where the into-ghost lands, when one was requested. */
  ghost: Rect | null
  height: number
}

/**
 * Re-flow one card's pages the way it looks mid-drag: the dragged-out page (`excludeId`) collapsed
 * away, an optional ghost of width `ghost.w` opened at visible index `ghost.index`, and no add-page
 * slot (it is hidden while a drag is in flight). Uses the same widths and wrap as the layout, so the
 * drop math and the rendered drag preview are computed by one function.
 */
export function reflowDoc(
  item: DocPlacement,
  excludeId: string | null,
  ghost: { index: number; w: number } | null
): DocReflow {
  const kept = item.pages.filter((p) => p.pageId !== excludeId)
  const widths = kept.map((p) => p.w)
  const ghostAt = ghost ? Math.max(0, Math.min(kept.length, ghost.index)) : -1
  if (ghost) widths.splice(ghostAt, 0, ghost.w)
  const { cells, rows } = flowDoc(widths, item.x, item.y, item.wrapWidth)
  const pages: PageSlot[] = []
  let ghostRect: Rect | null = null
  let k = 0
  cells.forEach((c, i) => {
    if (i === ghostAt) {
      ghostRect = { x: c.x, y: c.y, w: c.w, h: c.h }
      return
    }
    pages.push({ ...c, pageId: kept[k++].pageId })
  })
  return { pages, ghost: ghostRect, height: docHeightForRows(rows) }
}

export { computeDropTarget, betweenSlotY } from './drop-target'
export type { DropTarget } from './drop-target'
