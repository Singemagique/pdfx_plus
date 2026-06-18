/**
 * Places documents at fixed coordinates in the canvas "world" (CSS pixels at
 * scale 1). The Canvas component then pans/zooms this world as a whole.
 *
 * Layout is a centered vertical stack of filmstrips: each document is one row
 * of its pages at a fixed page height; rows are centered on a common X axis.
 * The geometry here MUST stay in sync with the card paddings in styles.css
 * (see the constants below) so the computed slot heights match what renders.
 */
import type { DocEntry } from '../types'

/** Page height in world units at scale 1. The transform handles zoom. */
export const BASE_PAGE_HEIGHT = 280
const PAGE_GAP = 18
// Horizontal inset to a page = doc-row padding (16) + page-strip-inner padding (6).
const CARD_PAD_X = 16 + 6
// Vertical: doc-row padding-top (10) + header block (height 20 + margin 12) +
// pages (BASE_PAGE_HEIGHT) + doc-row padding-bottom (14).
const CARD_PAD_TOP = 10
const HEADER_BLOCK = 32
const CARD_PAD_BOTTOM = 14
/** Gap between stacked documents. */
const DOC_GAP_Y = 30

// Documents are at least this many pages wide so that narrow (e.g. single-page)
// docs still form a consistent, left-aligned column rather than looking ragged.
const MIN_PAGES = 5
const REF_PAGE_WIDTH = Math.round((BASE_PAGE_HEIGHT * 612) / 792) // US-letter portrait
const MIN_DOC_WIDTH = MIN_PAGES * REF_PAGE_WIDTH + (MIN_PAGES - 1) * PAGE_GAP + CARD_PAD_X * 2

export interface DocPlacement {
  doc: DocEntry
  /** Top-left in world coordinates. */
  x: number
  y: number
  width: number
  height: number
}

export interface CanvasLayout {
  items: DocPlacement[]
  contentWidth: number
  contentHeight: number
  /** Height of one document slot incl. gap — used to fit ~N docs on load. */
  slotHeight: number
}

function pageDisplayWidth(width: number, height: number): number {
  return Math.max(6, Math.round((BASE_PAGE_HEIGHT * width) / height))
}

/** Natural width of a document's filmstrip card (incl. horizontal padding). */
function docWidth(doc: DocEntry): number {
  const pages = doc.pages
  const stripWidth =
    pages.reduce((sum, p) => sum + pageDisplayWidth(p.width, p.height), 0) +
    Math.max(0, pages.length - 1) * PAGE_GAP
  return stripWidth + CARD_PAD_X * 2
}

const DOC_HEIGHT = CARD_PAD_TOP + HEADER_BLOCK + BASE_PAGE_HEIGHT + CARD_PAD_BOTTOM

export function computeLayout(docs: DocEntry[]): CanvasLayout {
  const widths = docs.map((doc) => Math.max(MIN_DOC_WIDTH, docWidth(doc)))
  const contentWidth = Math.max(1, ...widths)

  let y = 0
  const items: DocPlacement[] = docs.map((doc, i) => {
    const placement: DocPlacement = {
      doc,
      // All documents share the same left edge (left-aligned column).
      x: 0,
      y,
      width: widths[i],
      height: DOC_HEIGHT
    }
    y += DOC_HEIGHT + DOC_GAP_Y
    return placement
  })

  const contentHeight = Math.max(1, y - DOC_GAP_Y)
  return { items, contentWidth, contentHeight, slotHeight: DOC_HEIGHT + DOC_GAP_Y }
}
