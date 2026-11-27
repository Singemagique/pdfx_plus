// Page text for search: pdf.js text items (with the geometry to draw matches) plus their
// normalized, searchable form. Type-only pdf.js imports — nothing here loads pdf.js at runtime.

import type { PDFDocumentProxy } from 'pdfjs-dist'
import { normalizeSegments, type Segment } from './normalize'

export type Matrix = [number, number, number, number, number, number]

export interface TextItemGeom {
  /** The raw pdf.js `str`. */
  str: string
  /** item.transform: text space → PDF user space (it includes the font size). */
  t: Matrix
  /** item.width: the run's advance along the baseline, in user units. */
  width: number
  /** item.height. */
  height: number
  /** Font ascent as a fraction of the font size (style.ascent, else 0.8). */
  ascent: number
  /** Font descent as a (negative) fraction of the font size (style.descent, else -0.2). */
  descent: number
  vertical: boolean
  rtl: boolean
}

export interface PageText {
  items: TextItemGeom[]
  /**
   * page.getViewport({ scale: 1 }).transform: PDF user space → display px. It bakes in the page's
   * intrinsic /Rotate, the y flip and the view box offset — the frame PageEntry.width/height
   * describe.
   */
  vt: number[]
  /** Normalized searchable text. */
  norm: string
  /** Per unit of `norm`: global raw offset into the items' str concatenated (-1: synthetic). */
  srcStart: Int32Array
  srcEnd: Int32Array
  /** Raw offset each item's str starts at. */
  itemStarts: Int32Array
}

export const EMPTY_PAGE_TEXT: PageText = Object.freeze({
  items: [],
  vt: [1, 0, 0, 1, 0, 0],
  norm: '',
  srcStart: new Int32Array(0),
  srcEnd: new Int32Array(0),
  itemStarts: new Int32Array(0)
}) as PageText

/** The subset of a pdf.js TextItem this module reads. */
export interface RawTextItem {
  str: string
  dir?: string
  transform: number[]
  width: number
  height: number
  fontName?: string
  hasEOL?: boolean
}

export interface RawTextStyle {
  ascent?: number
  descent?: number
  vertical?: boolean
}

/** An input item for buildPageText: pdf.js geometry plus whether a line break follows it. */
export type PageTextItem = TextItemGeom & { hasEOL: boolean }

/** A pdf.js text item + its font style → the geometry kept for drawing matches. */
export function toItemGeom(item: RawTextItem, style: RawTextStyle | undefined): PageTextItem {
  const t = item.transform
  return {
    str: item.str,
    t: [t[0] ?? 1, t[1] ?? 0, t[2] ?? 0, t[3] ?? 1, t[4] ?? 0, t[5] ?? 0],
    width: item.width,
    height: item.height,
    ascent: style?.ascent && style.ascent > 0 ? style.ascent : 0.8,
    descent: style?.descent && style.descent < 0 ? style.descent : -0.2,
    vertical: !!style?.vertical,
    rtl: item.dir === 'rtl',
    hasEOL: !!item.hasEOL
  }
}

const fontHeight = (it: TextItemGeom): number => Math.hypot(it.t[2], it.t[3]) || it.height || 1

/**
 * Whether `cur` starts a new line relative to `prev` even though pdf.js gave `prev` no hasEOL:
 * the baseline moved perpendicular to the text direction by more than half a line.
 */
function baselineJumped(prev: TextItemGeom, cur: TextItemGeom): boolean {
  const a = Math.atan2(prev.t[1], prev.t[0])
  const dx = cur.t[4] - prev.t[4]
  const dy = cur.t[5] - prev.t[5]
  const perp = Math.abs(-dx * Math.sin(a) + dy * Math.cos(a))
  return perp > 0.5 * fontHeight(prev)
}

/** Build a PageText from geometry-carrying items (separate from pdf.js so it can be unit-tested). */
export function buildPageText(items: readonly PageTextItem[], vt: readonly number[]): PageText {
  const segments: Segment[] = []
  // The last item with visible text, and whether a line break was flagged since it.
  let prev: PageTextItem | null = null
  let broke = false
  for (const it of items) {
    const solid = it.str.trim().length > 0
    const breakBefore =
      solid && prev !== null && !broke && !prev.vertical && baselineJumped(prev, it)
    segments.push({ str: it.str, hasEOL: it.hasEOL, breakBefore })
    if (solid) {
      prev = it
      broke = it.hasEOL
    } else if (it.hasEOL) broke = true
  }
  const n = normalizeSegments(segments)
  return {
    items: items.map(({ hasEOL: _hasEOL, ...geom }) => geom),
    vt: [...vt],
    norm: n.text,
    srcStart: n.srcStart,
    srcEnd: n.srcEnd,
    itemStarts: n.itemStarts
  }
}

/** Extract one page's text (pdf.js's own normalization stays on: it already expands ligatures). */
export async function extractPageText(pdf: PDFDocumentProxy, pageIndex: number): Promise<PageText> {
  const page = await pdf.getPage(pageIndex + 1)
  const vt = page.getViewport({ scale: 1 }).transform
  const content = await page.getTextContent()
  const styles = content.styles as Record<string, RawTextStyle | undefined>
  const items: PageTextItem[] = []
  for (const item of content.items) {
    if (!('str' in item)) continue
    const raw = item as RawTextItem
    items.push(toItemGeom(raw, raw.fontName ? styles[raw.fontName] : undefined))
  }
  return buildPageText(items, vt)
}
