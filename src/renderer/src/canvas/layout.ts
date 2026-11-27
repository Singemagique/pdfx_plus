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
/**
 * The narrowest the trailing "Add page" cell gets. It never opens a row of its own: where the last
 * row has no room for a full-width cell it shrinks (down to this) to sit at that row's end.
 */
export const ADD_PAGE_MIN_WIDTH = 48
/** Diameter of the round "Add page" button used when the last row is too full even for that. */
export const ADD_PAGE_EDGE_SIZE = 32

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
  /** Number of wrapped page rows. The add-page slot never adds one: it sits at the last row's end. */
  rows: number
  /** The width rows wrap to (outer card width, padding included). */
  wrapWidth: number
  /**
   * World x of the page grid's left edge. Every card spans the collection's width, so a card whose
   * rows are narrower centres its grid in the slack instead of leaving it all on the right.
   */
  gridX: number
  /** Every page's cell, in document order — the single source of truth for pixels and hit tests. */
  pages: PageSlot[]
  /** The trailing "Add page" slot, always on the last row. */
  addPage: AddPageSlot
}

export interface AddPageSlot extends Rect {
  /**
   * false: a page-height cell after the last page (ADD_PAGE_MIN_WIDTH up to a full page wide).
   * true: the last row is too full for one, so it is a round button straddling the card's right
   * edge, centred on that row — still no extra row, and no extra card width.
   */
  edge: boolean
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

interface GridFlow {
  positions: FlowPosition[]
  rows: number
  /** Width of the widest row. */
  extent: number
}

function flowGrid(widths: readonly number[], wrapWidth: number): GridFlow {
  const positions = flowCells(widths, innerWidth(wrapWidth))
  let rows = 1
  let extent = 0
  positions.forEach((p, i) => {
    rows = Math.max(rows, p.row + 1)
    extent = Math.max(extent, p.x + widths[i])
  })
  return { positions, rows, extent }
}

/** World-coordinate cells for `flow` with its grid's left edge at `gridX`, in a card at `docY`. */
function placeCells(
  flow: GridFlow,
  widths: readonly number[],
  gridX: number,
  docY: number
): Array<Rect & { row: number }> {
  return flow.positions.map((p, i) => ({
    x: gridX + p.x,
    y: rowTop(docY, p.row),
    w: widths[i],
    h: BASE_PAGE_HEIGHT,
    row: p.row
  }))
}

/** One document flowed into rows, before the collection's shared card width is known. */
interface DocFlow {
  doc: DocEntry
  widths: number[]
  flow: GridFlow
  /** Grid-relative x where the add-page slot starts: one gap after the last page. */
  addX: number
  /** The card width this document needs on its own (MIN_DOC_WIDTH at least). */
  natural: number
}

function flowDocument(doc: DocEntry, wrapWidth: number, rotations?: Rotations): DocFlow {
  const widths = doc.pages.map((p) => pageCellWidth(p, rotations))
  const flow = flowGrid(widths, wrapWidth)
  const last = flow.positions.length - 1
  const addX = last >= 0 ? flow.positions[last].x + widths[last] + PAGE_GAP : 0
  // The add-page slot rides on the last row instead of wrapping onto a row of its own. Where that
  // row has room for a full page-width cell within the wrap, the card is sized to hold it (as it
  // always was); a fuller row reserves nothing, so the slot never widens the collection.
  const fits = addX + ADD_PAGE_WIDTH <= innerWidth(wrapWidth)
  const reach = Math.max(flow.extent, fits ? addX + ADD_PAGE_WIDTH : 0)
  const natural = Math.max(MIN_DOC_WIDTH, reach + CARD_PAD_X * 2)
  return { doc, widths, flow, addX, natural }
}

/** Place a flowed document as a card `cardWidth` wide at `y`. */
function placeDoc(f: DocFlow, y: number, cardWidth: number, wrapWidth: number): DocPlacement {
  const span = cardWidth - CARD_PAD_X * 2
  // Centre the pages in whatever the shared width leaves over. Where an add-page cell could fit at
  // the end of the last row, centre only so far right that it still does.
  const centre = Math.max(0, Math.floor((span - f.flow.extent) / 2))
  const room = span - f.addX - ADD_PAGE_MIN_WIDTH
  const offset = room >= 0 ? Math.min(centre, room) : centre
  const gridX = CARD_PAD_X + offset
  const cells = placeCells(f.flow, f.widths, gridX, y)
  const rowY = rowTop(y, f.flow.positions.at(-1)?.row ?? 0)
  const addPage: AddPageSlot =
    room >= 0
      ? {
          x: gridX + f.addX,
          y: rowY,
          w: Math.min(ADD_PAGE_WIDTH, span - offset - f.addX),
          h: BASE_PAGE_HEIGHT,
          edge: false
        }
      : {
          x: cardWidth - ADD_PAGE_EDGE_SIZE / 2,
          y: rowY + (BASE_PAGE_HEIGHT - ADD_PAGE_EDGE_SIZE) / 2,
          w: ADD_PAGE_EDGE_SIZE,
          h: ADD_PAGE_EDGE_SIZE,
          edge: true
        }
  return {
    doc: f.doc,
    x: 0,
    y,
    width: cardWidth,
    height: docHeightForRows(f.flow.rows),
    rows: f.flow.rows,
    wrapWidth,
    gridX,
    pages: f.doc.pages.map((p, i) => ({ pageId: p.id, ...cells[i] })),
    addPage
  }
}

/**
 * Lay the collection out as a column of document cards, each wrapping its pages into rows no wider
 * than `wrapWidth` world px (clamped to at least MIN_DOC_WIDTH). Card heights follow their row
 * count, and each card's y is the cumulative height of those above it. Every card spans the
 * collection's width (the widest card's) so the edges line up, with its pages centred inside.
 */
export function computeLayout(
  docs: DocEntry[],
  rotations?: Rotations,
  wrapWidth: number = DEFAULT_WRAP_WIDTH
): CanvasLayout {
  const wrap = Math.max(MIN_DOC_WIDTH, wrapWidth)
  const flows = docs.map((doc) => flowDocument(doc, wrap, rotations))
  const contentWidth = Math.max(1, ...flows.map((f) => f.natural))
  let y = 0
  const items = flows.map((f) => {
    const placement = placeDoc(f, y, contentWidth, wrap)
    y += placement.height + DOC_GAP_Y
    return placement
  })
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
 *
 * The grid stays where the card centred it, so pages do not drift as the drag opens and closes
 * gaps; it only moves left as far as a row the ghost widened needs to stay inside the card.
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
  const flow = flowGrid(widths, item.wrapWidth)
  const inset = item.x + CARD_PAD_X
  const offset = Math.max(
    0,
    Math.min(item.gridX - inset, item.width - CARD_PAD_X * 2 - flow.extent)
  )
  const cells = placeCells(flow, widths, inset + offset, item.y)
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
  return { pages, ghost: ghostRect, height: docHeightForRows(flow.rows) }
}

export { computeDropTarget, betweenSlotY } from './drop-target'
export type { DropTarget, DropView } from './drop-target'
