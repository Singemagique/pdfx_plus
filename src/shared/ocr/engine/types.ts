// Engine-facing types (DESIGN.md §3.2.7). DOM-free and Electron-free: the recognize thread, the
// coordinator, vitest and (later) other engines' adapters all speak these.
//
// Frames. Everything here is in IMAGE PIXELS of the raster the engine saw: origin top-left, y down,
// before any mapping to the overlay frame (map.ts does that).

/** An 8-bit grey raster, rows top to bottom. `stride` defaults to `width`. */
export interface GrayImage {
  width: number
  height: number
  data: Uint8Array
  stride?: number
}

/** An axis-aligned pixel box, hOCR convention: x0,y0 inclusive top-left, x1,y1 exclusive. */
export interface PxBox {
  x0: number
  y0: number
  x1: number
  y1: number
}

export interface RawWord {
  text: string
  bbox: PxBox
  /** Raw engine confidence 0..100, null if the engine gives none. */
  conf: number | null
  /** One box per character of `text` (code points), when the engine reports them. */
  chars?: PxBox[]
}

export interface RawLine {
  bbox: PxBox
  /**
   * hOCR baseline: `y = slope · (x − bbox.x0) + (bbox.y1 + intercept)` in image px (y down), so a
   * positive slope falls to the right on screen. Null when the engine gives none.
   */
  baseline: { slope: number; intercept: number } | null
  /** x-height in px (x_size − x_ascenders − x_descenders; PR0 confirmed), 0 when unknown. */
  xHeight: number
  /** hOCR `x_size`: the line's em height in px (ascender to descender), 0 when unknown. */
  size: number
  /** hOCR `textangle` (degrees, counter-clockwise), when given. */
  angle?: number
  /** The enclosing paragraph's language (Tesseract code), when given. */
  lang?: string
  /** The hOCR class the line came from (all four are lines in Tesseract 5). */
  kind: 'ocr_line' | 'ocr_header' | 'ocr_caption' | 'ocr_textfloat'
  words: RawWord[]
}

/** One recognition of one image, before mapping (§3.2.7). */
export interface RawOcr {
  /** Reading order (block → paragraph → line, as the engine emitted them). */
  lines: RawLine[]
  /** Mean raw word confidence over words with one, null if none. */
  meanConf: number | null
  confSource: 'word' | 'line' | 'none'
}

/**
 * A raw confidence → P(word correct) map: monotone, piecewise linear over `points` (raw 0..100
 * ascending, p 0..1 non-decreasing). Fitted offline (PR6); see calibration.ts.
 */
export interface CalibrationTable {
  engineId: string
  /** True for the uncalibrated stand-in shipped before the PR6 fit. */
  placeholder: boolean
  points: ReadonlyArray<readonly [raw: number, p: number]>
}
