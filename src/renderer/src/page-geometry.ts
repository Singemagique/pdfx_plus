/**
 * How a page is DISPLAYED: its crop window and edit rotation, the way it will export.
 *
 * Frames and units
 * - `PageEntry.width/height` come from pdf.js `getViewport({ scale: 1 })`: the page's visual frame.
 *   The intrinsic /Rotate is already applied, the origin is the view box's own corner (pdf.js
 *   subtracts the CropBox ∩ MediaBox origin), and the user's EDIT rotation is not applied.
 * - A `CropBox` is stored in that same frame, in PDF points with a bottom-left origin.
 * - Overlay geoms, form-widget geoms and Find rects all live in that frame too.
 *
 * So the display transform needs NO view-box origin term: pdf.js has already removed it, and only
 * export (pdfx/build.ts) adds it back. Pages whose MediaBox starts away from (0, 0) display
 * correctly as long as nothing here adds `view[0]/view[1]` again.
 *
 * The display transform is: offset by the crop window (y flipped to a top-left origin), then
 * scale, then the edit rotation applied about the window's centre (CSS `rotate()`, clockwise).
 *
 * Consumers keep working in FULL-page coordinates: the visible box is the crop window
 * (`overflow: hidden`, carrying any rotate/zoom transform) and inside it a `.page-frame` sized to the
 * whole page is positioned by {@link fullPageInWindow}. Offsetting by the crop origin and clipping to
 * the crop both come from that frame position plus the window's `overflow: hidden`.
 */

import type { PageEntry } from './types'
import { makePageKey, type CropBox } from './edit/model'

export interface PageSize {
  width: number
  height: number
}

/** A region of the page in page px, top-left origin (the frame Find rects use). */
export interface PageWindow {
  x: number
  y: number
  w: number
  h: number
}

export type QuarterTurn = 0 | 90 | 180 | 270

export interface PageFrame {
  /** The full page (PageEntry dims). */
  page: PageSize
  /** What is shown: the crop, or the whole page `{0, 0, W, H}`. */
  window: PageWindow
  cropped: boolean
  /** The edit rotation. */
  rotation: QuarterTurn
  /** The window's size before the edit rotation (= window.w / window.h). */
  uprightW: number
  uprightH: number
  /** The displayed size, after the edit rotation (swapped for 90/270). */
  w: number
  h: number
}

/** Normalise any rotation to 0 / 90 / 180 / 270. */
export function normalizeRotation(rotation: number): QuarterTurn {
  const r = ((Math.round(rotation / 90) * 90) % 360) + 360
  return (r % 360) as QuarterTurn
}

const isQuarter = (r: QuarterTurn): boolean => r === 90 || r === 270

/**
 * The crop as a top-left-origin window over the page, clamped to the page. Null when there is no
 * crop, or it is non-finite or empty once clamped (the page then shows whole).
 */
export function cropWindow(page: PageSize, crop?: CropBox | null): PageWindow | null {
  if (!crop) return null
  const { x, y, w, h } = crop
  if (![x, y, w, h].every(Number.isFinite)) return null
  const W = page.width
  const H = page.height
  const left = Math.max(0, x)
  const right = Math.min(W, x + w)
  const bottom = Math.max(0, y)
  const top = Math.min(H, y + h)
  if (!(right - left > 0) || !(top - bottom > 0)) return null
  return { x: left, y: H - top, w: right - left, h: top - bottom }
}

/**
 * The part of the page that is shown, in PDF points with a bottom-left origin (the overlay frame):
 * the crop clamped to the page, or the whole page when uncropped.
 */
export function visibleBox(
  page: PageSize,
  crop?: CropBox | null
): { x: number; y: number; w: number; h: number } {
  const win = cropWindow(page, crop)
  if (!win) return { x: 0, y: 0, w: page.width, h: page.height }
  return { x: win.x, y: page.height - win.y - win.h, w: win.w, h: win.h }
}

export function pageFrame(page: PageSize, rotation = 0, crop?: CropBox | null): PageFrame {
  const win = cropWindow(page, crop)
  const shown = win ?? { x: 0, y: 0, w: page.width, h: page.height }
  const rot = normalizeRotation(rotation)
  const q = isQuarter(rot)
  return {
    page: { width: page.width, height: page.height },
    window: shown,
    cropped: win !== null,
    rotation: rot,
    uprightW: shown.w,
    uprightH: shown.h,
    w: q ? shown.h : shown.w,
    h: q ? shown.w : shown.h
  }
}

/** The displayed (cropped, then rotated) size of a page, in page px. */
export function effectiveSize(
  page: PageSize,
  rotation = 0,
  crop?: CropBox | null
): { w: number; h: number } {
  const f = pageFrame(page, rotation, crop)
  return { w: f.w, h: f.h }
}

export interface PageEdits {
  rotations?: Map<string, number>
  crops?: Map<string, CropBox>
}

/** Look up a PageEntry's frame from the edit maps. `ignoreCrop` is for crop-edit mode. */
export function frameOf(
  page: PageEntry,
  edits: PageEdits,
  opts?: { ignoreCrop?: boolean }
): PageFrame {
  const key = makePageKey(page.source.id, page.pageIndex)
  const rot = edits.rotations?.get(key) ?? 0
  const crop = opts?.ignoreCrop ? null : edits.crops?.get(key)
  return pageFrame(page, rot, crop)
}

/**
 * Where the FULL page sits inside an upright window box `boxW × boxH` css px: scaled so the window
 * is contained in the box and centred, so a clamped or rounded cell aspect never distorts the page.
 */
export function fullPageInWindow(
  frame: PageFrame,
  boxW: number,
  boxH: number
): { left: number; top: number; width: number; height: number; scale: number } {
  const win = frame.window
  const s = Math.min(boxW / win.w, boxH / win.h)
  return {
    left: -win.x * s + (boxW - win.w * s) / 2,
    top: -win.y * s + (boxH - win.h * s) / 2,
    width: frame.page.width * s,
    height: frame.page.height * s,
    scale: s
  }
}

export interface WindowFractions {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** The window as fractions of the page (for PageView's `clip`), or null when uncropped. */
export function windowFractions(frame: PageFrame): WindowFractions | null {
  if (!frame.cropped) return null
  const { x, y, w, h } = frame.window
  const W = frame.page.width
  const H = frame.page.height
  return { x0: x / W, y0: y / H, x1: (x + w) / W, y1: (y + h) / H }
}

/**
 * Page px (top-left origin) → displayed px (top-left of the displayed, rotated window; scale 1).
 * CSS rotate() turns clockwise with y down, so the window point (u, v) of a `uw × uh` window lands
 * in the displayed box at  90: (uh - v, u)   180: (uw - u, uh - v)   270: (v, uw - u).
 */
export function pageToDisplay(frame: PageFrame, x: number, y: number): { x: number; y: number } {
  const { window: win, rotation } = frame
  const u = x - win.x
  const v = y - win.y
  switch (rotation) {
    case 90:
      return { x: win.h - v, y: u }
    case 180:
      return { x: win.w - u, y: win.h - v }
    case 270:
      return { x: v, y: win.w - u }
    default:
      return { x: u, y: v }
  }
}

/** The inverse of {@link pageToDisplay}. */
export function displayToPage(frame: PageFrame, x: number, y: number): { x: number; y: number } {
  const { window: win, rotation } = frame
  let u: number
  let v: number
  switch (rotation) {
    case 90:
      u = y
      v = win.h - x
      break
    case 180:
      u = win.w - x
      v = win.h - y
      break
    case 270:
      u = win.w - y
      v = x
      break
    default:
      u = x
      v = y
  }
  return { x: u + win.x, y: v + win.y }
}
