import type { DocEntry, PageEntry } from '../types'
import { makePageKey } from '../edit/model'

export type Rotations = Map<string, number>

const isRotated = (rot: number | undefined): boolean => rot === 90 || rot === 270

export const BASE_PAGE_HEIGHT = 280
export const PAGE_GAP = 18
export const CARD_PAD_X = 16 + 6
const CARD_PAD_TOP = 10
const HEADER_BLOCK = 32
const CARD_PAD_BOTTOM = 14
export const DOC_GAP_Y = 30

const MIN_PAGES = 5
const REF_PAGE_WIDTH = Math.round((BASE_PAGE_HEIGHT * 612) / 792)
export const MIN_DOC_WIDTH =
  MIN_PAGES * REF_PAGE_WIDTH + (MIN_PAGES - 1) * PAGE_GAP + CARD_PAD_X * 2

export const ADD_PAGE_WIDTH = REF_PAGE_WIDTH
const ADD_PAGE_SLOT = PAGE_GAP + ADD_PAGE_WIDTH

export interface DocPlacement {
  doc: DocEntry
  x: number
  y: number
  width: number
  height: number
}

export interface CanvasLayout {
  items: DocPlacement[]
  contentWidth: number
  contentHeight: number
  slotHeight: number
}

export function pageDisplayWidth(width: number, height: number): number {
  return Math.max(6, Math.round((BASE_PAGE_HEIGHT * width) / height))
}

/** Display width at the fixed strip height, accounting for a 90°/270° rotation. */
export function pageCellWidth(page: PageEntry, rotations?: Rotations): number {
  const rot = rotations?.get(makePageKey(page.source.id, page.pageIndex))
  return isRotated(rot)
    ? pageDisplayWidth(page.height, page.width)
    : pageDisplayWidth(page.width, page.height)
}

function docWidth(doc: DocEntry, rotations?: Rotations): number {
  const pages = doc.pages
  const stripWidth =
    pages.reduce((sum, p) => sum + pageCellWidth(p, rotations), 0) +
    Math.max(0, pages.length - 1) * PAGE_GAP
  return stripWidth + ADD_PAGE_SLOT + CARD_PAD_X * 2
}

export const DOC_HEIGHT = CARD_PAD_TOP + HEADER_BLOCK + BASE_PAGE_HEIGHT + CARD_PAD_BOTTOM

export function computeLayout(docs: DocEntry[], rotations?: Rotations): CanvasLayout {
  const widths = docs.map((doc) => Math.max(MIN_DOC_WIDTH, docWidth(doc, rotations)))
  const contentWidth = Math.max(1, ...widths)

  let y = 0
  const items: DocPlacement[] = docs.map((doc, i) => {
    const placement: DocPlacement = {
      doc,
      x: 0,
      y,
      width: widths[i],
      height: DOC_HEIGHT
    }
    y += DOC_HEIGHT + DOC_GAP_Y
    return placement
  })

  let contentHeight = Math.max(1, y - DOC_GAP_Y)
  if (docs.length > 0) contentHeight += DOC_GAP_Y + DOC_HEIGHT
  return { items, contentWidth, contentHeight, slotHeight: DOC_HEIGHT + DOC_GAP_Y }
}

export const DOC_SLOT = DOC_HEIGHT + DOC_GAP_Y

export { computeDropTarget, betweenSlotY } from './drop-target'
export type { DropTarget } from './drop-target'
